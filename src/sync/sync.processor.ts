import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { SyncService } from './sync.service';

/**
 * Background worker for every marketplace-sync job:
 *  - 'publish':    create the listing on the marketplace
 *  - 'inventory':  push local stock/price to a published listing
 *  - 'falabella-feed': check how a batch sent to Falabella turned out
 *  - 'falabella-order': pull recent Falabella orders after a webhook ping
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
                if (marketplace === 'falabella') {
                    // Publicar de a uno pasa por el mismo camino que el lote:
                    // así hay una sola forma de hablar con Falabella, y un
                    // producto suelto es simplemente un lote de uno.
                    const resultado = await this.syncService.publishBatchToFalabella(userId, [productId]);
                    if (resultado.enviados === 0) {
                        throw new Error(resultado.rechazados[0]?.motivo || 'El producto no cumple los requisitos de Falabella.');
                    }
                    return { status: 'enviado', feed: resultado.lotes[0]?.feedId };
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

            case 'falabella-feed': {
                // Falabella procesa los lotes en segundo plano: esto pregunta
                // cómo fue y, si aún no terminó, se reprograma solo.
                const { feedRecordId, userId } = job.data;
                return this.syncService.checkFalabellaFeed(feedRecordId, userId);
            }

            case 'falabella-order': {
                // Se consultan los pedidos recientes: el aviso solo dice que
                // algo pasó, los datos buenos vienen de la API.
                const { userId } = job.data;
                return this.syncService.processFalabellaOrders(userId);
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
