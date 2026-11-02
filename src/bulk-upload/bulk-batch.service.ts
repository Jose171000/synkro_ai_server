import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { BulkBatch } from './entities/bulk-batch.entity';
import { BulkBatchItem } from './entities/bulk-batch-item.entity';

export interface ResumenDeLote {
    total: number;
    processed: number;
    failed: number;
    terminado: boolean;
    /** Productos que no se pudieron crear y por qué. */
    fallidos: { sku: string; error: string }[];
    /** Filas del Excel que ni siquiera entraron a la cola. */
    rechazadas: string[];
    /** Cómo va el envío a Falabella (solo productos que van a ese canal). */
    falabella: { pendientes: number; enviados: number; rechazados: number };
    falabellaRechazados: { sku: string; error: string }[];
    /** Fallidos que ya se volvieron a mandar en otro lote. */
    reintentados: number;
}

export interface ParaReintentar {
    storeId: string | null;
    /** Un lote en marcha no se reintenta: sus pendientes todavía se están procesando. */
    puedeReintentarse: boolean;
    fallidos: { sku: string; payload: Record<string, any> }[];
    /** Productos ya creados que quedaron sin enviarse a Falabella. */
    falabellaPendientes: string[];
    /** Datos del trabajo original (canales, cuentas, usuario) para reenviar a Falabella. */
    payloadBase: Record<string, any> | null;
}

/** Un lote en marcha más viejo que esto se da por trabado (Redis perdió su cuenta) y puede reintentarse. */
const HORAS_PARA_DAR_POR_TRABADO = 2;

/**
 * Registro durable de las cargas masivas. Redis sigue llevando la cuenta y el cierre del lote; esto guarda lo que queda
 * cuando Redis caduca o se reinicia. Ningún método lanza: un fallo al anotar un producto no debe tumbar su creación.
 */
@Injectable()
export class BulkBatchService {
    private readonly logger = new Logger(BulkBatchService.name);

    constructor(
        @InjectRepository(BulkBatch) private readonly lotes: Repository<BulkBatch>,
        @InjectRepository(BulkBatchItem) private readonly items: Repository<BulkBatchItem>,
    ) { }

    private async seguro<T>(que: string, tarea: () => Promise<T>): Promise<T | undefined> {
        try {
            return await tarea();
        } catch (error: any) {
            this.logger.warn(`No se pudo ${que}: ${error?.message}`);
            return undefined;
        }
    }

    /** Anota el lote y un renglón pendiente por cada producto que entró a la cola. */
    async crear(
        batchId: string,
        userId: string,
        storeId: string | undefined,
        items: { sku: string; payload: Record<string, any> }[],
        rechazadas: string[] = [],
    ): Promise<void> {
        await this.seguro('anotar el lote', async () => {
            await this.lotes.save(this.lotes.create({ id: batchId, userId, storeId: storeId ?? null, total: items.length, status: 'running', rejected: rechazadas }));
            // De a 200 renglones por inserción: un Excel de mil filas no arma una consulta gigante.
            for (let i = 0; i < items.length; i += 200) {
                await this.items.save(items.slice(i, i + 200).map((x) => this.items.create({ batchId, sku: x.sku, status: 'pendiente', payload: x.payload })));
            }
        });
    }

    /** Anota cómo terminó un producto. Con reintentos, el último resultado manda. */
    async marcar(batchId: string, sku: string, resultado: { ok: boolean; productId?: string; error?: string }): Promise<void> {
        await this.seguro('anotar el producto del lote', async () => {
            await this.items.update(
                { batchId, sku },
                resultado.ok
                    ? { status: 'listo', error: null, productId: resultado.productId ?? null }
                    : { status: 'fallido', error: (resultado.error ?? 'error desconocido').slice(0, 500) },
            );
        });
    }

    /** El producto quedó esperando su tanda de envío a Falabella. */
    async falabellaPendiente(batchId: string, productId: string): Promise<void> {
        await this.seguro('anotar el producto pendiente de Falabella', async () => {
            await this.items.update({ batchId, productId }, { falabellaStatus: 'pendiente', falabellaError: null });
        });
    }

    /**
     * Resultado de una tanda: todos los productos de la tanda pasan a «enviado» y los que Falabella no aceptó, a «rechazado» con su motivo.
     * Lo que ya existía en Falabella (se vincula, no se vuelve a publicar) cuenta como enviado.
     */
    async falabellaResultado(batchId: string, productIds: string[], rechazados: { sku: string; motivo: string }[]): Promise<void> {
        await this.seguro('anotar el resultado de la tanda de Falabella', async () => {
            if (productIds.length) await this.items.update({ batchId, productId: In(productIds) }, { falabellaStatus: 'enviado', falabellaError: null });
            for (const r of rechazados) {
                if (/^ya (está publicado|existía)/i.test(r.motivo)) continue;
                await this.items.update({ batchId, sku: r.sku }, { falabellaStatus: 'rechazado', falabellaError: r.motivo.slice(0, 500) });
            }
        });
    }

    /** Productos del lote que siguen esperando su envío a Falabella (por ejemplo, si Redis perdió la lista). */
    async pendientesDeFalabella(batchId: string): Promise<string[]> {
        const filas = await this.seguro('leer los pendientes de Falabella', () => this.items.find({ where: { batchId, falabellaStatus: 'pendiente' }, select: ['productId'] }));
        return (filas ?? []).map((f) => f.productId).filter((id): id is string => !!id);
    }

    /** Cierra el lote (cuando Redis dice que llegó al total). */
    async cerrar(batchId: string): Promise<void> {
        await this.seguro('cerrar el lote', async () => {
            await this.lotes.update({ id: batchId }, { status: 'done', finishedAt: new Date() });
        });
    }

    /** El estado de un lote desde la base (solo para quien lo subió). null si no existe. */
    async resumen(batchId: string, userId: string): Promise<ResumenDeLote | null> {
        const lote = await this.seguro('leer el lote', () => this.lotes.findOne({ where: { id: batchId } }));
        if (!lote || lote.userId !== userId) return null;
        const items = (await this.seguro('leer los productos del lote', () => this.items.find({ where: { batchId }, select: ['sku', 'status', 'error', 'falabellaStatus', 'falabellaError'] }))) ?? [];
        const processed = items.filter((i) => i.status === 'listo').length;
        const fallidos = items.filter((i) => i.status === 'fallido').map((i) => ({ sku: i.sku, error: i.error ?? '' }));
        return {
            total: lote.total,
            processed,
            failed: fallidos.length,
            terminado: lote.status === 'done' || processed + fallidos.length >= lote.total,
            fallidos,
            rechazadas: lote.rejected ?? [],
            falabella: {
                pendientes: items.filter((i) => i.falabellaStatus === 'pendiente').length,
                enviados: items.filter((i) => i.falabellaStatus === 'enviado').length,
                rechazados: items.filter((i) => i.falabellaStatus === 'rechazado').length,
            },
            falabellaRechazados: items.filter((i) => i.falabellaStatus === 'rechazado').map((i) => ({ sku: i.sku, error: i.falabellaError ?? '' })),
            reintentados: items.filter((i) => i.status === 'reintentado').length,
        };
    }

    /** Lo que se puede volver a mandar de un lote: productos fallidos (con sus datos) y los que quedaron sin enviar a Falabella. */
    async paraReintentar(batchId: string, userId: string): Promise<ParaReintentar | null> {
        const lote = await this.seguro('leer el lote', () => this.lotes.findOne({ where: { id: batchId } }));
        if (!lote || lote.userId !== userId) return null;
        const items = (await this.seguro('leer los productos del lote', () => this.items.find({ where: { batchId } }))) ?? [];
        const viejo = Date.now() - new Date(lote.createdAt).getTime() > HORAS_PARA_DAR_POR_TRABADO * 3_600_000;
        return {
            storeId: lote.storeId ?? null,
            puedeReintentarse: lote.status === 'done' || viejo,
            fallidos: items.filter((i) => i.status === 'fallido' && i.payload).map((i) => ({ sku: i.sku, payload: i.payload! })),
            falabellaPendientes: items.filter((i) => i.falabellaStatus === 'pendiente' && i.productId).map((i) => i.productId!),
            payloadBase: items.find((i) => i.payload)?.payload ?? null,
        };
    }

    /** Anota que estos productos fallidos ya salieron en otro lote, para no reintentarlos dos veces. */
    async marcarReintentados(batchId: string, skus: string[]): Promise<void> {
        await this.seguro('anotar los reintentos', async () => {
            if (skus.length) await this.items.update({ batchId, sku: In(skus), status: 'fallido' }, { status: 'reintentado' });
        });
    }
}
