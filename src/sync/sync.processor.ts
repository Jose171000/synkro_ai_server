import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { SyncService } from './sync.service';
import { ChangeRequestsService } from './change-requests.service';

/**
 * Background worker for every marketplace-sync job:
 *  - 'publish':    create the listing on the marketplace
 *  - 'inventory':  push local stock/price to a published listing
 *  - 'falabella-feed': check how a batch sent to Falabella turned out
 *  - 'falabella-order': pull recent Falabella orders after a webhook ping
 *  - 'meli-order': apply a Mercado Libre sale to local stock and propagate
 *  - 'poll-orders': periodic pass that pulls recent sales from every account
 */
@Processor('marketplace-sync-queue')
export class SyncProcessor extends WorkerHost {
    constructor(
        private readonly syncService: SyncService,
        private readonly changeRequests: ChangeRequestsService,
    ) {
        super();
    }

    async process(job: Job<any, any, string>): Promise<any> {
        console.log(`[SyncProcessor] Job ${job.id} (${job.name})`, job.data);

        switch (job.name) {
            case 'publish': {
                const { productId, userId, storeId, marketplace, connectionId } = job.data;
                if (marketplace === 'mercadolibre') {
                    const link = await this.syncService.publishToMeli(productId, userId, connectionId);
                    return { status: 'published', externalId: link.externalId };
                }
                if (marketplace === 'falabella') {
                    // Publicar de a uno pasa por el mismo camino que el lote:
                    // así hay una sola forma de hablar con Falabella, y un
                    // producto suelto es simplemente un lote de uno.
                    try {
                        const resultado = await this.syncService.publishBatchToFalabella({ userId, storeId }, connectionId, [productId]);
                        // Si ya estaba en Falabella (publicado o vinculado) no es un fallo: no hay nada más que enviar.
                        if (resultado.enviados === 0 && /^ya (est[aá] publicado|exist[ií]a)/.test(resultado.rechazados[0]?.motivo ?? "")) {
                            return { status: "ya-publicado" };
                        }
                        if (resultado.enviados === 0) {
                            // No cumple lo que pide Falabella: reintentar no cambiaría nada.
                            throw new UnrecoverableError(resultado.rechazados[0]?.motivo || 'El producto no cumple los requisitos de Falabella.');
                        }
                        return { status: 'enviado', feed: resultado.lotes[0]?.feedId };
                    } catch (error: any) {
                        // Con el último intento (o un fallo sin remedio) el motivo queda en el producto y se avisa; antes se perdía.
                        const ultimo = error instanceof UnrecoverableError || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
                        if (ultimo) await this.syncService.marcarPublicacionFallida(productId, connectionId, userId, error?.message ?? 'error desconocido');
                        throw error;
                    }
                }
                throw new Error(`Marketplace no soportado aún: ${marketplace}`);
            }

            case 'inventory': {
                const { productId, marketplace, connectionId, changeRequestId } = job.data;
                try {
                    let result: any;
                    if (marketplace === 'mercadolibre') {
                        await this.syncService.pushInventoryToMeli(productId, connectionId);
                        result = { status: 'synced' };
                    } else if (marketplace === 'falabella') {
                        result = await this.syncService.pushInventoryToFalabella(productId, connectionId);
                    } else if (this.syncService.hasChannel(marketplace)) {
                        await this.syncService.pushInventoryToChannel(marketplace, productId, connectionId);
                        result = { status: 'synced' };
                    } else {
                        throw new Error(`Marketplace no soportado aún: ${marketplace}`);
                    }
                    // Si el envío nació de una aprobación, se cierra la solicitud.
                    if (changeRequestId) await this.changeRequests.markResult(changeRequestId, true);
                    return result;
                } catch (error: any) {
                    if (changeRequestId) await this.changeRequests.markResult(changeRequestId, false, error?.message);
                    throw error;
                }
            }

            case 'falabella-feed': {
                // Falabella procesa los lotes en segundo plano: esto pregunta
                // cómo fue y, si aún no terminó, se reprograma solo.
                const { feedRecordId, userId, intento = 0 } = job.data;
                try {
                    return await this.syncService.checkFalabellaFeed(feedRecordId, userId, intento);
                } catch (error: any) {
                    // Un fallo al comprobar no debe dejar el producto en «Publicando…»: se vuelve a intentar.
                    return this.syncService.reintentarRevisionDeFeed(feedRecordId, userId, intento, error?.message ?? 'error desconocido');
                }
            }

            case 'content-update': {
                // Se guardó un cambio en el producto: se manda a cada canal donde está publicado.
                const { productId, connectionId, marketplace } = job.data;
                const r = await this.syncService.runContentSync(productId, connectionId, marketplace);
                return { status: r.ok ? 'enviado' : 'omitido', message: r.message };
            }

            case 'poll-orders': {
                // Pasada periódica: ventas recientes de todas las cuentas.
                return this.syncService.pollAllOrders();
            }

            case 'sync-listings': {
                // Pasada periódica: estado de las publicaciones de todas las cuentas.
                return this.syncService.refreshAllListings();
            }

            case 'falabella-order': {
                // Se consultan los pedidos recientes: el aviso solo dice que
                // algo pasó, los datos buenos vienen de la API.
                const { userId, connectionId } = job.data;
                return this.syncService.processFalabellaOrders({ userId, connectionId });
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
