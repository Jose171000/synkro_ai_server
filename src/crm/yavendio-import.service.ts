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
            if (!lead && phone) {
                const digits = this.onlyDigits(phone);
                if (digits.length >= 8) {
                    lead = await this.leadRepository
                        .createQueryBuilder('l')
                        .where('l.ownerId = :ownerId', { ownerId })
                        .andWhere(`regexp_replace(COALESCE(l.phone,''), '\D', '', 'g') = :digits`, { digits })
                        .getOne();
                }
            }

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
