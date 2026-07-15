import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { SyncService } from './sync.service';

/**
 * Background worker for every marketplace-sync job:
 *  - 'publish':    create the listing on the marketplace
 *  - 'inventory':  push local stock/price to a published listing
 *  - 'meli-order': apply a Mercado Libre sale to local stock and propagate
 */
@Processor('marketplace-sync-queue')
export class SyncProcessor extends WorkerHost {
    constructor(private readonly syncService: SyncService) {
        super();
    }

    async process(job: Job<any, any, string>): Promise<any> {
        console.log(`[SyncProcessor] Job ${job.id} (${job.name})`, job.data);

        switch (job.name) {
            case 'publish': {
                const { productId, userId, marketplace } = job.data;
                if (marketplace === 'mercadolibre') {
                    const link = await this.syncService.publishToMeli(productId, userId);
                    return { status: 'published', externalId: link.externalId };
                }
                throw new Error(`Marketplace no soportado aún: ${marketplace}`);
            }

            case 'inventory': {
                const { productId, userId, marketplace } = job.data;
                if (marketplace === 'mercadolibre') {
                    await this.syncService.pushInventoryToMeli(productId, userId);
                    return { status: 'synced' };
                }
                throw new Error(`Marketplace no soportado aún: ${marketplace}`);
            }

            case 'meli-order': {
                const { resource, meliUserId } = job.data;
                await this.syncService.processMeliOrder(resource, meliUserId);
                return { status: 'processed' };
            }

            default:
                console.warn(`[SyncProcessor] Job desconocido: ${job.name}`);
                return null;
        }
    }
}
