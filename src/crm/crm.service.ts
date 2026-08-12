import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { Lead, LEAD_STAGES, LeadStage } from './entities/lead.entity';
import { CreateLeadDto, UpdateLeadDto } from './dto/lead.dto';

/**
 * Nombres de columna aceptados para cada campo. Las hojas de cálculo
 * reales nunca usan los mismos encabezados, así que reconocemos las
 * variantes más habituales en castellano e inglés.
 */
const COLUMN_ALIASES: Record<string, string[]> = {
    name: ['nombre', 'name', 'contacto', 'cliente', 'prospecto', 'nombre completo', 'nombres', 'lead'],
    company: ['empresa', 'company', 'negocio', 'compania', 'compañia', 'compañía', 'razon social', 'razón social', 'marca'],
    email: ['email', 'correo', 'e-mail', 'mail', 'correo electronico', 'correo electrónico'],
    phone: ['telefono', 'teléfono', 'phone', 'celular', 'whatsapp', 'movil', 'móvil', 'numero', 'número', 'contacto telefonico'],
    source: ['origen', 'source', 'fuente', 'canal', 'procedencia', 'medio', 'como nos conocio', 'cómo nos conoció'],
    stage: ['estado', 'stage', 'etapa', 'status', 'situacion', 'situación', 'fase'],
    estimatedValue: ['valor', 'monto', 'value', 'presupuesto', 'ticket', 'importe', 'valor estimado'],
    notes: ['notas', 'notes', 'observaciones', 'comentarios', 'detalle', 'descripcion', 'descripción'],
    lastContactAt: ['fecha', 'date', 'ultimo contacto', 'último contacto', 'fecha contacto', 'fecha de contacto'],
};

/** Texto libre del estado → etapa del embudo. */
const STAGE_ALIASES: Record<string, LeadStage> = {
    nuevo: 'nuevo', new: 'nuevo', 'sin contactar': 'nuevo', pendiente: 'nuevo', prospecto: 'nuevo',
    contactado: 'contactado', contacted: 'contactado', 'en contacto': 'contactado', seguimiento: 'contactado',
    calificado: 'calificado', qualified: 'calificado', interesado: 'calificado', 'en proceso': 'calificado',
    propuesta: 'propuesta', proposal: 'propuesta', cotizado: 'propuesta', cotizacion: 'propuesta', 'cotización': 'propuesta', negociacion: 'propuesta', 'negociación': 'propuesta',
    ganado: 'ganado', won: 'ganado', cerrado: 'ganado', cliente: 'ganado', vendido: 'ganado',
    perdido: 'perdido', lost: 'perdido', descartado: 'perdido', 'no interesado': 'perdido', frio: 'perdido', 'frío': 'perdido',
};

export interface ImportPreviewRow {
    name: string;
    company?: string;
    email?: string;
    phone?: string;
    stage: LeadStage;
    action: 'nuevo' | 'actualiza' | 'omitido';
    reason?: string;
}

@Injectable()
export class CrmService {
    constructor(
        @InjectRepository(Lead) private readonly leadRepository: Repository<Lead>,
    ) { }

    // ─────────────────────────────────────────────────────────────
    // CRUD
    // ─────────────────────────────────────────────────────────────

    async findAll(search?: string, stage?: string) {
        const qb = this.leadRepository.createQueryBuilder('l').orderBy('l.updatedAt', 'DESC');

        if (search) {
            qb.andWhere(
                '(l.name ILIKE :q OR l.company ILIKE :q OR l.email ILIKE :q OR l.phone ILIKE :q)',
                { q: `%${search}%` },
            );
        }
        if (stage) {
            qb.andWhere('l.stage = :stage', { stage });
        }
        return qb.getMany();
    }

    async getSummary() {
        const rows = await this.leadRepository
            .createQueryBuilder('l')
            .select('l.stage', 'stage')
            .addSelect('COUNT(*)', 'count')
            .addSelect('COALESCE(SUM(l.estimatedValue),0)', 'value')
            .groupBy('l.stage')
            .getRawMany();

        const byStage = LEAD_STAGES.map(stage => {
            const row = rows.find(r => r.stage === stage);
            return {
                stage,
                count: Number(row?.count || 0),
                value: Number(row?.value || 0),
            };
        });

        const total = byStage.reduce((s, b) => s + b.count, 0);
        // El "pipeline abierto" excluye lo ya ganado o perdido
        const openValue = byStage
            .filter(b => !['ganado', 'perdido'].includes(b.stage))
            .reduce((s, b) => s + b.value, 0);
        const wonValue = byStage.find(b => b.stage === 'ganado')?.value ?? 0;

        return { total, byStage, openValue, wonValue };
    }

    async create(dto: CreateLeadDto) {
        const lead = this.leadRepository.create({
            ...dto,
            stage: (dto.stage as LeadStage) || 'nuevo',
            externalKey: this.buildKey(dto.email, dto.phone, dto.name),
            origin: 'manual',
        });
        return this.leadRepository.save(lead);
    }

    async update(id: string, dto: UpdateLeadDto) {
        const lead = await this.leadRepository.findOne({ where: { id } });
        if (!lead) throw new NotFoundException('Prospecto no encontrado');

        Object.assign(lead, dto);
        lead.externalKey = this.buildKey(lead.email, lead.phone, lead.name);
        return this.leadRepository.save(lead);
    }

    async remove(id: string) {
        const lead = await this.leadRepository.findOne({ where: { id } });
        if (!lead) throw new NotFoundException('Prospecto no encontrado');
        await this.leadRepository.remove(lead);
        return { message: 'Prospecto eliminado' };
    }

    // ─────────────────────────────────────────────────────────────
    // Importación desde Google Sheets
    // ─────────────────────────────────────────────────────────────

    /**
     * Lee el CSV publicado, reconoce las columnas y crea o actualiza los
     * prospectos. Con dryRun solo devuelve la vista previa: así el usuario
     * confirma que el mapeo es correcto antes de tocar sus datos.
     */
    async importFromCsv(csvUrl: string, dryRun = false) {
        let raw: string;
        try {
            const { data } = await axios.get(csvUrl, { timeout: 20000, responseType: 'text' });
            raw = String(data);
        } catch (error: any) {
            throw new BadRequestException(
                `No se pudo leer la hoja: ${error?.message}. Verifica que esté publicada como CSV.`,
            );
        }

        if (raw.trimStart().startsWith('<')) {
            throw new BadRequestException(
                'La URL devolvió una página web, no un CSV. En Google Sheets usa Archivo → Compartir → Publicar en la web → CSV.',
            );
        }

        const rows = this.parseCsv(raw);
        if (rows.length < 2) {
            throw new BadRequestException('La hoja está vacía o solo tiene encabezados.');
        }

        const headers = rows[0].map(h => this.normalize(h));
        const mapping = this.detectColumns(headers);

        if (mapping.name === -1) {
            throw new BadRequestException(
                `No encontré una columna de nombre. Encabezados detectados: ${rows[0].join(', ')}. ` +
                `Renombra una columna a "nombre" o "contacto".`,
            );
        }

        const preview: ImportPreviewRow[] = [];
        let created = 0;
        let updated = 0;
        let skipped = 0;

        for (const cols of rows.slice(1)) {
            const name = (cols[mapping.name] ?? '').trim();
            if (!name) {
                skipped++;
                continue; // fila vacía: no aporta nada
            }

            const email = mapping.email !== -1 ? (cols[mapping.email] ?? '').trim() : '';
            const phone = mapping.phone !== -1 ? (cols[mapping.phone] ?? '').trim() : '';
            const key = this.buildKey(email, phone, name);

            const existing = await this.leadRepository.findOne({ where: { externalKey: key } });

            const payload: Partial<Lead> = {
                name,
                company: mapping.company !== -1 ? (cols[mapping.company] ?? '').trim() || null as any : undefined,
                email: email || null as any,
                phone: phone || null as any,
                source: mapping.source !== -1 ? (cols[mapping.source] ?? '').trim() || null as any : undefined,
                stage: this.normalizeStage(mapping.stage !== -1 ? cols[mapping.stage] : ''),
                estimatedValue: mapping.estimatedValue !== -1 ? this.parseAmount(cols[mapping.estimatedValue]) : undefined,
                notes: mapping.notes !== -1 ? (cols[mapping.notes] ?? '').trim() || null as any : undefined,
                lastContactAt: mapping.lastContactAt !== -1 ? this.parseDate(cols[mapping.lastContactAt]) : undefined,
                externalKey: key,
                origin: 'sheets',
            };

            preview.push({
                name,
                company: payload.company as string,
                email: payload.email as string,
                phone: payload.phone as string,
                stage: payload.stage as LeadStage,
                action: existing ? 'actualiza' : 'nuevo',
            });

            if (dryRun) {
                existing ? updated++ : created++;
                continue;
            }

            if (existing) {
                // No pisamos con vacíos lo que ya había
                Object.entries(payload).forEach(([k, v]) => {
                    if (v !== undefined && v !== null && v !== '') (existing as any)[k] = v;
                });
                await this.leadRepository.save(existing);
                updated++;
            } else {
                await this.leadRepository.save(this.leadRepository.create(payload));
                created++;
            }
        }

        return {
            dryRun,
            detectedColumns: Object.entries(mapping)
                .filter(([, idx]) => idx !== -1)
                .map(([field, idx]) => ({ field, header: rows[0][idx] })),
            ignoredHeaders: rows[0].filter((_, i) => !Object.values(mapping).includes(i)),
            totalRows: rows.length - 1,
            created,
            updated,
            skipped,
            preview: preview.slice(0, 20),
        };
    }

    // ─────────────────────────────────────────────────────────────
    // Utilidades
    // ─────────────────────────────────────────────────────────────

    private normalize(text: string): string {
        return (text || '')
            .trim()
            .toLowerCase()
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, ''); // quita acentos para comparar
    }

    private detectColumns(headers: string[]): Record<string, number> {
        const mapping: Record<string, number> = {};
        for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
            const normalizedAliases = aliases.map(a => this.normalize(a));
            // Coincidencia exacta primero; si no, que el encabezado contenga el alias
            let idx = headers.findIndex(h => normalizedAliases.includes(h));
            if (idx === -1) {
                idx = headers.findIndex(h => normalizedAliases.some(a => h.includes(a)));
            }
            mapping[field] = idx;
        }
        return mapping;
    }

    private normalizeStage(value?: string): LeadStage {
        const normalized = this.normalize(value || '');
        if (!normalized) return 'nuevo';
        if (STAGE_ALIASES[normalized]) return STAGE_ALIASES[normalized];
        // Coincidencia parcial: "ya es cliente" → ganado
        const found = Object.keys(STAGE_ALIASES).find(k => normalized.includes(k));
        return found ? STAGE_ALIASES[found] : 'nuevo';
    }

    /**
     * Interpreta importes tal como se escriben en una hoja: "S/ 3,500",
     * "12.000,50", "8000", "$1,234.56". La clave es distinguir el
     * separador de miles del decimal, o "3,500" acabaría valiendo 3.5.
     */
    private parseAmount(value?: string): number | undefined {
        if (!value) return undefined;

        // Fuera símbolos de moneda, espacios y cualquier texto
        let cleaned = String(value).replace(/[^0-9.,-]/g, '').trim();
        if (!cleaned) return undefined;

        const lastComma = cleaned.lastIndexOf(',');
        const lastDot = cleaned.lastIndexOf('.');

        if (lastComma !== -1 && lastDot !== -1) {
            // Conviven ambos: el último es el decimal ("1.234,56" o "1,234.56")
            const decimalSep = lastComma > lastDot ? ',' : '.';
            const thousandSep = decimalSep === ',' ? '.' : ',';
            cleaned = cleaned.split(thousandSep).join('');
            cleaned = cleaned.replace(decimalSep, '.');
        } else if (lastComma !== -1 || lastDot !== -1) {
            const sep = lastComma !== -1 ? ',' : '.';
            const pos = lastComma !== -1 ? lastComma : lastDot;
            const decimals = cleaned.length - pos - 1;
            const occurrences = cleaned.split(sep).length - 1;

            // Un único separador con 3 dígitos detrás ("3,500") son miles.
            // Varios separadores ("1.234.567") también son miles.
            if (occurrences > 1 || decimals === 3) {
                cleaned = cleaned.split(sep).join('');
            } else {
                cleaned = cleaned.replace(sep, '.');
            }
        }

        const num = Number(cleaned);
        return Number.isFinite(num) && num !== 0 ? num : undefined;
    }

    private parseDate(value?: string): string | undefined {
        const raw = (value || '').trim();
        if (!raw) return undefined;
        if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
        const m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
        if (m) {
            const year = m[3].length === 2 ? `20${m[3]}` : m[3];
            return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
        }
        return undefined;
    }

    /** Identidad de la fila: correo > teléfono > nombre. */
    private buildKey(email?: string, phone?: string, name?: string): string {
        if (email) return `email:${this.normalize(email)}`;
        if (phone) return `phone:${String(phone).replace(/\D/g, '')}`;
        return `name:${this.normalize(name || '')}`;
    }

    private parseCsv(text: string): string[][] {
        const rows: string[][] = [];
        let row: string[] = [];
        let field = '';
        let inQuotes = false;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];

            if (inQuotes) {
                if (char === '"') {
                    if (text[i + 1] === '"') { field += '"'; i++; }
                    else inQuotes = false;
                } else field += char;
                continue;
            }

            if (char === '"') { inQuotes = true; continue; }
            if (char === ',') { row.push(field); field = ''; continue; }
            if (char === '\n' || char === '\r') {
                if (char === '\r' && text[i + 1] === '\n') i++;
                row.push(field);
                if (row.some(c => c.trim())) rows.push(row);
                row = [];
                field = '';
                continue;
            }
            field += char;
        }

        if (field || row.length) {
            row.push(field);
            if (row.some(c => c.trim())) rows.push(row);
        }
        return rows;
    }
}
