import { Injectable, Inject, Logger } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

export interface BatchMeta {
    batchId:   string;
    batchTotal: number;
    userEmail: string;
    jobType:   string; // e.g. "Creación masiva de productos"
}

@Injectable()
export class BatchNotificationService {
    private readonly logger = new Logger(BatchNotificationService.name);
    private readonly TTL_SECONDS = 86_400; // 24 h

    constructor(
        @Inject(REDIS_CLIENT) private readonly redis: Redis,
        private readonly mailService: MailService,
    ) {}

    /** Anota un lote nuevo: quién lo subió y cuántos productos lleva, para poder mostrar su avance. */
    async iniciar(batchId: string, total: number, userId: string): Promise<void> {
        const key = `batch:${batchId}`;
        await this.redis.hsetnx(key, 'total', String(total));
        await this.redis.hsetnx(key, 'processed', '0');
        await this.redis.hsetnx(key, 'failed', '0');
        await this.redis.hsetnx(key, 'owner', userId);
        await this.redis.expire(key, this.TTL_SECONDS);
    }

    /** Avance de un lote (solo para quien lo subió). null si no existe o ya caducó. */
    async progreso(batchId: string, userId: string): Promise<{ total: number; processed: number; failed: number; terminado: boolean } | null> {
        const datos = await this.redis.hgetall(`batch:${batchId}`);
        if (!datos || !datos.total) return null;
        if (datos.owner && datos.owner !== userId) return null;
        const total = Number(datos.total);
        const processed = Number(datos.processed ?? 0);
        const failed = Number(datos.failed ?? 0);
        return { total, processed, failed, terminado: processed + failed >= total };
    }

    /**
     * Called by a processor after each job completes (success or failure).
     * Increments the batch counter and fires an email when the batch is done.
     *
     * @param meta     Batch metadata passed in every job's data payload
     * @param success  Whether this particular job succeeded
     */
    async trackAndNotify(meta: BatchMeta, success: boolean, cantidad = 1): Promise<boolean> {
        if (!meta?.batchId) return false; // safety guard — jobs without batch tracking skip silently

        const key = `batch:${meta.batchId}`;

        // Todo en una sola transacción de Redis: se inicializa, se suma y se lee sin que otro producto
        // se cuele en medio. Con varios productos terminando a la vez, cada uno ve el estado justo
        // después de su propia suma, y solo uno de ellos hace llegar el total a la meta.
        const respuesta = await this.redis
            .multi()
            .hsetnx(key, 'total', String(meta.batchTotal))
            .hsetnx(key, 'processed', '0')
            .hsetnx(key, 'failed', '0')
            // Un producto con variantes suma todas sus variantes de una vez.
            .hincrby(key, success ? 'processed' : 'failed', Math.max(1, Math.trunc(cantidad)))
            .hmget(key, 'total', 'processed', 'failed')
            .expire(key, this.TTL_SECONDS)
            .exec();

        const lectura = respuesta?.[4];
        if (!lectura || lectura[0] || !Array.isArray(lectura[1])) {
            throw new Error(`No se pudo actualizar el avance del lote ${meta.batchId}: ${lectura?.[0]?.message ?? 'sin respuesta de Redis'}`);
        }
        const [total, processed, failed] = lectura[1] as (string | null)[];

        const totalN     = Number(total     ?? 0);
        const processedN = Number(processed ?? 0);
        const failedN    = Number(failed    ?? 0);

        this.logger.log(`[Batch ${meta.batchId}] ${processedN + failedN}/${totalN} (✓${processedN} ✗${failedN})`);

        // Cierra el lote quien lo deja justo en el total: la suma solo sube y el total es la suma de todos los trabajos, así que llega
        // a ese valor una sola vez (antes era «>=» y, con varios a la vez, dos podían cerrarlo o ninguno).
        const completo = processedN + failedN === totalN;
        if (completo) {
            // Se conserva una hora (no se borra): la pantalla todavía puede mostrar el resultado final.
            await this.redis.expire(key, 3600);

            try {
                await this.mailService.sendJobCompleted(
                    meta.userEmail,
                    meta.userEmail,
                    meta.jobType,
                    processedN,
                    failedN,        // ← now shown in email when > 0
                );
                this.logger.log(`[Batch ${meta.batchId}] Notification sent to ${meta.userEmail}`);
            } catch (err) {
                this.logger.error(`[Batch ${meta.batchId}] Failed to send email: ${err.message}`);
            }
        }
        return completo;
    }

    /** Deja anotado un producto para publicarlo en el canal cuando termine todo el lote. */
    async deferPublish(batchId: string, channel: string, productId: string): Promise<number> {
        const key = `batch:${batchId}:publish:${channel}`;
        const res = await this.redis.multi().sadd(key, productId).expire(key, this.TTL_SECONDS).scard(key).exec();
        const cuantos = Number(res?.[2]?.[1]);
        return Number.isFinite(cuantos) ? cuantos : 0;
    }

    /**
     * Anota juntas las variantes de un producto: quedan como UNA entrada, así una tanda las saca todas o ninguna (separadas,
     * Falabella puede armar familias distintas). Devuelve cuántos productos esperan en total.
     */
    async deferPublishFamilia(batchId: string, channel: string, productIds: string[]): Promise<number> {
        if (productIds.length <= 1) return productIds.length ? this.deferPublish(batchId, channel, productIds[0]) : 0;
        const key = `batch:${batchId}:publish:${channel}`;
        const res = await this.redis.multi().sadd(key, productIds.join(SEPARADOR_DE_FAMILIA)).expire(key, this.TTL_SECONDS).smembers(key).exec();
        const entradas = res?.[2]?.[1];
        return Array.isArray(entradas) ? expandir(entradas as string[]).length : 0;
    }

    /**
     * Saca (y borra) los productos anotados: solo quien lo pida primero los recibe.
     * Con `max` saca como mucho esa cantidad de entradas (una tanda; una familia de variantes es una entrada) y deja el resto anotado.
     */
    async takeDeferred(batchId: string, channel: string, max?: number): Promise<string[]> {
        const key = `batch:${batchId}:publish:${channel}`;
        if (max && max > 0) {
            const ids = await this.redis.spop(key, max);
            return expandir(Array.isArray(ids) ? ids : ids ? [String(ids)] : []);
        }
        const res = await this.redis.multi().smembers(key).del(key).exec();
        const ids = res?.[0]?.[1];
        return Array.isArray(ids) ? expandir(ids as string[]) : [];
    }
}

/** Las variantes de una familia van en una sola entrada, separadas por esto (los ids son UUID: nunca lo llevan). */
const SEPARADOR_DE_FAMILIA = ',';
const expandir = (entradas: string[]): string[] => entradas.flatMap((e) => String(e).split(SEPARADOR_DE_FAMILIA)).filter(Boolean);

