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
    async trackAndNotify(meta: BatchMeta, success: boolean): Promise<boolean> {
        if (!meta?.batchId) return false; // safety guard — jobs without batch tracking skip silently

        const key = `batch:${meta.batchId}`;

        // Initialize the hash on first use (SET if not exists pattern via HSETNX)
        await this.redis.hsetnx(key, 'total',    String(meta.batchTotal));
        await this.redis.hsetnx(key, 'processed', '0');
        await this.redis.hsetnx(key, 'failed',    '0');
        await this.redis.expire(key, this.TTL_SECONDS);

        // Atomically increment the right counter
        if (success) {
            await this.redis.hincrby(key, 'processed', 1);
        } else {
            await this.redis.hincrby(key, 'failed', 1);
        }

        // Read current totals
        const [total, processed, failed] = await Promise.all([
            this.redis.hget(key, 'total'),
            this.redis.hget(key, 'processed'),
            this.redis.hget(key, 'failed'),
        ]);

        const totalN     = Number(total     ?? 0);
        const processedN = Number(processed ?? 0);
        const failedN    = Number(failed    ?? 0);

        this.logger.log(`[Batch ${meta.batchId}] ${processedN + failedN}/${totalN} (✓${processedN} ✗${failedN})`);

        // Batch complete — send email and cleanup
        const completo = processedN + failedN >= totalN;
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
    async deferPublish(batchId: string, channel: string, productId: string): Promise<void> {
        const key = `batch:${batchId}:publish:${channel}`;
        await this.redis.sadd(key, productId);
        await this.redis.expire(key, this.TTL_SECONDS);
    }

    /** Saca (y borra) los productos anotados: solo quien lo pida primero los recibe. */
    async takeDeferred(batchId: string, channel: string): Promise<string[]> {
        const key = `batch:${batchId}:publish:${channel}`;
        const res = await this.redis.multi().smembers(key).del(key).exec();
        const ids = res?.[0]?.[1];
        return Array.isArray(ids) ? (ids as string[]) : [];
    }
}
