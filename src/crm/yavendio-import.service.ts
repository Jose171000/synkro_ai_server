import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Lead, LeadStage } from './entities/lead.entity';
import { SyncService } from '../sync/sync.service';
import { YavendioApiService, YavendioConversation } from '../sync/yavendio/yavendio-api.service';

export interface YavendioImportOptions {
    /** Calcula el resultado sin escribir nada. */
    dryRun?: boolean;
    /** Deja fuera las conversaciones que nunca tuvieron un mensaje. */
    skipEmpty?: boolean;
}

export interface YavendioImportResult {
    total: number;
    created: number;
    updated: number;
    skipped: number;
    byStage: Record<string, number>;
    sample: { name: string; stage: LeadStage; action: string }[];
}

/** Prefijo del identificador de origen, para no chocar con otras fuentes. */
const KEY_PREFIX = 'yavendio:';

/** Etapas que representan un cierre: no se pisan en importaciones futuras. */
const CLOSED_STAGES: LeadStage[] = ['ganado', 'perdido'];

@Injectable()
export class YavendioImportService {
    private readonly logger = new Logger('YavendioImport');

    constructor(
        @InjectRepository(Lead) private readonly leadRepository: Repository<Lead>,
        private readonly syncService: SyncService,
        private readonly yavendioApi: YavendioApiService,
    ) { }

    /**
     * Traduce una conversación de WhatsApp a una etapa del embudo.
     *
     * Yavendió marca explícitamente las ventas cerradas (sale_status), que es
     * la señal más fiable. Para el resto usamos si hubo o no conversación:
     * un contacto sin un solo mensaje es un prospecto sin contactar, y uno
     * con mensajes ya está contactado. Las etapas intermedias (calificado,
     * propuesta) las decide una persona, no se adivinan desde un chat.
     */
    private mapStage(conversation: YavendioConversation): LeadStage {
        if (conversation.sale_status === 'positive') return 'ganado';
        if (conversation.sale_status === 'negative') return 'perdido';
        const tuvoMensajes = !!conversation.last_message_preview || !!conversation.last_message_direction;
        return tuvoMensajes ? 'contactado' : 'nuevo';
    }

    /** Nota del lead: el último mensaje, avisando si la pelota está en tu cancha. */
    private buildNotes(conversation: YavendioConversation): string | undefined {
        const preview = (conversation.last_message_preview || '').trim();
        const pendiente = conversation.last_message_direction === 'inbound';
        const partes = [
            pendiente ? '⚠️ Te escribieron y aún no hay respuesta.' : null,
            preview ? `Último mensaje: ${preview}` : null,
        ].filter(Boolean);
        return partes.length ? partes.join('\n') : undefined;
    }

    private onlyDigits(value?: string | null): string {
        return String(value || '').replace(/\D/g, '');
    }

    /** El prospecto de este dueño con ese teléfono, comparando solo los dígitos («+51 999-888» y «51999888» son el mismo). */
    private async findByPhone(ownerId: string, phone: string): Promise<Lead | null> {
        const digits = this.onlyDigits(phone);
        if (digits.length < 8) return null;
        return this.leadRepository
            .createQueryBuilder('l')
            .where('l.ownerId = :ownerId', { ownerId })
            .andWhere(`regexp_replace(COALESCE(l.phone,''), '\\D', '', 'g') = :digits`, { digits })
            .getOne();
    }

    /**
     * Trae los contactos de Yavendió al embudo como prospectos nuevos. Quien ya está en el CRM (por el id del contacto
     * o por su teléfono, por ejemplo porque ya escribió) no se toca: su etapa y sus notas son trabajo de una persona.
     */
    async importContacts(ownerId: string, options: { dryRun?: boolean } = {}): Promise<{ total: number; created: number; existing: number; skipped: number; sample: string[] }> {
        const apiKey = await this.syncService.getYavendioApiKey(ownerId);
        const contactos = await this.yavendioApi.listContacts(apiKey);
        const result = { total: contactos.length, created: 0, existing: 0, skipped: 0, sample: [] as string[] };

        for (const contacto of contactos) {
            const phone = (contacto.phone || '').trim();
            const name = (contacto.name || '').trim();
            if (!phone && !name) { result.skipped++; continue; }

            const externalKey = `${KEY_PREFIX}contacto:${contacto.id}`;
            const yaEsta = (await this.leadRepository.findOne({ where: { externalKey, owner: { id: ownerId } } }))
                ?? (phone ? await this.findByPhone(ownerId, phone) : null);
            if (yaEsta) { result.existing++; continue; }

            const notas = [
                contacto.tags?.length ? `Etiquetas: ${contacto.tags.join(', ')}` : null,
                contacto.unsubscribed_at ? 'Se dio de baja de los mensajes: no escribirle.' : null,
            ].filter(Boolean).join('\n');

            if (!options.dryRun) {
                await this.leadRepository.save(this.leadRepository.create({
                    owner: { id: ownerId } as any,
                    name: name || phone,
                    phone: phone || undefined,
                    source: 'yavendio',
                    stage: 'nuevo',
                    notes: notas || undefined,
                    externalKey,
                    origin: 'yavendio',
                }));
            }
            result.created++;
            if (result.sample.length < 8) result.sample.push(name || phone);
        }

        this.logger.log(`Contactos de Yavendió${options.dryRun ? ' (simulado)' : ''}: ${result.created} nuevos, ${result.existing} ya estaban, ${result.skipped} omitidos de ${result.total}.`);
        return result;
    }

    async import(ownerId: string, options: YavendioImportOptions = {}): Promise<YavendioImportResult> {
        // Se usa la conexión de quien pide la importación: cada cuenta trae sus
        // propias conversaciones a su propio embudo.
        const apiKey = await this.syncService.getYavendioApiKey(ownerId);
        const conversations = await this.yavendioApi.listConversations(apiKey);

        const result: YavendioImportResult = {
            total: conversations.length,
            created: 0,
            updated: 0,
            skipped: 0,
            byStage: {},
            sample: [],
        };

        for (const conversation of conversations) {
            const tuvoMensajes = !!conversation.last_message_preview || !!conversation.last_message_direction;
            if (options.skipEmpty && !tuvoMensajes) {
                result.skipped++;
                continue;
            }

            const name = (conversation.customer?.name || '').trim();
            const phone = (conversation.customer?.phone_number || '').trim();
            if (!name && !phone) {
                result.skipped++; // sin forma de identificar a la persona
                continue;
            }

            const externalKey = `${KEY_PREFIX}${conversation.id}`;
            const stage = this.mapStage(conversation);

            // Primero por identificador de la conversación; si no, por teléfono,
            // para no duplicar a alguien que ya entró por la hoja de cálculo.
            let lead = await this.leadRepository.findOne({
                where: { externalKey, owner: { id: ownerId } },
            });
            if (!lead && phone) lead = await this.findByPhone(ownerId, phone);

            const notes = this.buildNotes(conversation);
            const lastContactAt = conversation.updated_at ? conversation.updated_at.slice(0, 10) : undefined;

            if (!lead) {
                if (!options.dryRun) {
                    await this.leadRepository.save(this.leadRepository.create({
                        owner: { id: ownerId } as any,
                        name: name || phone,
                        phone: phone || undefined,
                        source: 'yavendio',
                        stage,
                        notes,
                        lastContactAt,
                        externalKey,
                        origin: 'yavendio',
                    }));
                }
                result.created++;
                if (result.sample.length < 8) result.sample.push({ name: name || phone, stage, action: 'nuevo' });
            } else {
                // Nunca se pisa el trabajo manual: si alguien movió el lead a
                // "propuesta", una reimportación no lo devuelve a "contactado".
                // Solo mandan los cierres que Yavendió confirma.
                const cierreConfirmado = CLOSED_STAGES.includes(stage);
                if (!options.dryRun) {
                    lead.phone = lead.phone || phone || undefined as any;
                    lead.externalKey = externalKey;
                    if (notes) lead.notes = notes;
                    if (lastContactAt) lead.lastContactAt = lastContactAt;
                    if (cierreConfirmado) lead.stage = stage;
                    await this.leadRepository.save(lead);
                }
                result.updated++;
                if (result.sample.length < 8) {
                    result.sample.push({ name: name || phone, stage: cierreConfirmado ? stage : lead.stage, action: 'actualiza' });
                }
            }

            result.byStage[stage] = (result.byStage[stage] || 0) + 1;
        }

        this.logger.log(
            `Importación Yavendió${options.dryRun ? ' (simulada)' : ''}: ` +
            `${result.created} nuevos, ${result.updated} actualizados, ${result.skipped} omitidos de ${result.total}.`,
        );
        return result;
    }
}
