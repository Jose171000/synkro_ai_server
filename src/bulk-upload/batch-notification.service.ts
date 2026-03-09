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

    /**
     * Called by a processor after each job completes (success or failure).
     * Increments the batch counter and fires an email when the batch is done.
     *
     * @param meta     Batch metadata passed in every job's data payload
     * @param success  Whether this particular job succeeded
     */
    async trackAndNotify(meta: BatchMeta, success: boolean): Promise<void> {
        if (!meta?.batchId) return; // safety guard — jobs without batch tracking skip silently

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
        if (processedN + failedN >= totalN) {
            await this.redis.del(key);

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
    }
}
