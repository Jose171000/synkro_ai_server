import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
}

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
        const items = (await this.seguro('leer los productos del lote', () => this.items.find({ where: { batchId }, select: ['sku', 'status', 'error'] }))) ?? [];
        const processed = items.filter((i) => i.status === 'listo').length;
        const fallidos = items.filter((i) => i.status === 'fallido').map((i) => ({ sku: i.sku, error: i.error ?? '' }));
        return {
            total: lote.total,
            processed,
            failed: fallidos.length,
            terminado: lote.status === 'done' || processed + fallidos.length >= lote.total,
            fallidos,
            rechazadas: lote.rejected ?? [],
        };
    }
}
