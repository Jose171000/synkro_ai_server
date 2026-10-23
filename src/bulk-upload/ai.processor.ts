import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { AiService } from '../ai/ai.service';
import { ProductsService } from '../products/products.service';
import { SyncService } from '../sync/sync.service';
import { FalabellaAutoPrepService } from '../ai/falabella-auto-prep.service';
import { InternalServerErrorException } from '@nestjs/common';
import { BatchNotificationService, BatchMeta } from './batch-notification.service';
import { CuentasElegidas, cuentasParaPublicar, leerCuentasElegidas } from '../sync/cuentas-elegidas';

@Processor('generate-listings-queue')
export class AiProcessor extends WorkerHost {
    constructor(
        private readonly aiService: AiService,
        private readonly productsService: ProductsService,
        private readonly syncService: SyncService,
        private readonly falabellaPrep: FalabellaAutoPrepService,
        private readonly batchNotification: BatchNotificationService,
    ) {
        super();
    }

    async process(job: Job<any, any, string>): Promise<any> {
        console.log(`[AiProcessor] Processing job ${job.id} for product: ${job.data.productName}`);

        const { sku, productName, description, targetMarketplaces, userId, imageUrl, storeId, price, stock, salePrice, saleStartDate, saleEndDate } = job.data;
        // Varias fotos por producto; los trabajos anteriores traían una sola.
        const imagenes: string[] = job.data.imageUrls ?? (imageUrl ? [imageUrl] : []);
        const publishTo: string[] = job.data.publishTo ?? [];
        const cuentas = leerCuentasElegidas(job.data.cuentas);

        const batchMeta: BatchMeta | undefined = job.data.batchId ? {
            batchId:    job.data.batchId,
            batchTotal: job.data.batchTotal,
            userEmail:  job.data.userEmail,
            jobType:    'Creación masiva de productos',
        } : undefined;

        // Con reintentos, solo el último intento cuenta como fallo del lote; antes se vuelve a intentar sin contarlo.
        const ultimoIntento = job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);

        try {
            // 1. Create the product with the resolved image URL (if any). En un reintento ya existe: se retoma sin duplicar.
            const existente = job.attemptsMade > 0 ? await this.productsService.findBySku({ userId, storeId }, sku) : null;
            const product = existente ?? await this.productsService.create({
                name: productName || sku,
                description: description || '',
                sku,
                price,
                stock,
                salePrice: salePrice ?? null,
                saleStartDate: saleStartDate ?? null,
                saleEndDate: saleEndDate ?? null,
                targetMarketplaces,
                images: imagenes,
            } as any, userId, storeId);

            // 2. Generate AI content. En masivo se estima todo lo que falte (datos obligatorios y
            // medidas del paquete) para que se pueda publicar sin pasar por revisión.
            const aiContent = await this.aiService.generateProductContent({
                name: productName || '',
                description: description || '',
                targetMarketplaces,
                imageUrls: imagenes,
                userId,
                estimar: true,
            });

            // 3. Misma lógica que la creación individual: atributos por canal, medidas y lo visto en las fotos.
            this.productsService.applyAiContent(product, aiContent);
            product.status = 'synced';
            // Sin nombre o descripción en el Excel, los arma la IA a partir de las fotos.
            if (!productName) product.name = (product.aiTitle || aiContent.vision?.suggestedName || sku).slice(0, 255);
            if (!description) product.description = product.aiDescription || aiContent.vision?.description || '';
            const updatedProduct = await this.productsService.save(product);

            console.log(`[AiProcessor] ✓ Job ${job.id} done -> Product ${updatedProduct.id}`);

            // 4. Publicación automática en los canales conectados (los errores no tumban el producto).
            await this.publicar(updatedProduct.id, publishTo, { userId, storeId }, batchMeta?.batchId, cuentas);

            // Track batch progress — notify user when all jobs in this upload are done
            if (batchMeta) {
                const terminado = await this.batchNotification.trackAndNotify(batchMeta, true);
                if (terminado) await this.publicarFalabellaDelLote(batchMeta.batchId, publishTo, { userId, storeId }, cuentas);
            }

            return { status: 'completed', productId: updatedProduct.id };
        } catch (error) {
            console.error(`[AiProcessor] Job ${job.id} failed (intento ${job.attemptsMade + 1}):`, error);
            if (!ultimoIntento) throw new InternalServerErrorException('Error processing AI background job');

            // Track failed job too — batch must still complete
            if (batchMeta) {
                const terminado = await this.batchNotification.trackAndNotify(batchMeta, false);
                if (terminado) await this.publicarFalabellaDelLote(batchMeta.batchId, publishTo, { userId, storeId }, cuentas);
            }

            throw new InternalServerErrorException('Error processing AI background job');
        }
    }

    /** Cuentas activas de la tienda en un canal. */
    private async cuentasDe(storeId: string, canal: string): Promise<string[]> {
        const cuentas = await this.syncService.getConnections(storeId);
        return cuentas.filter((c: any) => c.status === 'active' && c.marketplace === canal).map((c: any) => c.id as string);
    }

    /**
     * Mercado Libre se publica enseguida, producto a producto. Falabella limita las llamadas de
     * publicación (50 seguidas y luego 2 minutos entre cada una), así que sus productos se anotan
     * y se mandan juntos, en un solo envío, cuando el lote termina.
     */
    private async publicar(productId: string, canales: string[], scope: { userId: string; storeId?: string }, batchId?: string, elegidas: CuentasElegidas = {}) {
        if (!scope.storeId || !canales.length) return;
        for (const canal of canales) {
            try {
                if (canal === 'falabella' && batchId) {
                    await this.batchNotification.deferPublish(batchId, 'falabella', productId);
                    continue;
                }
                for (const connectionId of cuentasParaPublicar(await this.cuentasDe(scope.storeId, canal), elegidas[canal])) {
                    await this.syncService.enqueuePublish({ userId: scope.userId, storeId: scope.storeId }, productId, [canal], { [canal]: connectionId });
                }
            } catch (error: any) {
                console.warn(`[AiProcessor] No se pudo encolar ${productId} en ${canal}: ${error?.message}`);
            }
        }
    }

    /** Un solo envío a Falabella con todo lo del lote. Lo hace quien cierra el lote. */
    private async publicarFalabellaDelLote(batchId: string, canales: string[], scope: { userId: string; storeId?: string }, elegidas: CuentasElegidas = {}) {
        if (!scope.storeId || !canales.includes('falabella')) return;
        try {
            const ids = await this.batchNotification.takeDeferred(batchId, 'falabella');
            if (!ids.length) return;
            const cuentas = cuentasParaPublicar(await this.cuentasDe(scope.storeId, 'falabella'), elegidas['falabella']);
            if (!cuentas.length) return;
            // Cada producto se deja listo para Falabella (marca contra su catálogo, atributos, medidas, descripción HTML)
            // antes de enviar el lote; si uno falla se envía igual y el motivo queda en su ficha.
            // De a 4 a la vez: son varias llamadas a la IA por producto y un lote grande tardaría demasiado de a uno.
            const porRevisar: { sku: string; motivo: string }[] = [];
            for (let i = 0; i < ids.length; i += 4) {
                const resultados = await Promise.allSettled(
                    ids.slice(i, i + 4).map((id) => this.falabellaPrep.preparar({ userId: scope.userId, storeId: scope.storeId! }, id, cuentas[0])),
                );
                resultados.forEach((r, j) => {
                    if (r.status === 'rejected') console.warn(`[AiProcessor] No se pudo preparar ${ids[i + j]} para Falabella: ${(r.reason as any)?.message}`);
                    else if (!r.value.category) porRevisar.push({ sku: r.value.sku ?? ids[i + j], motivo: r.value.categoryNote ?? 'sin categoría segura' });
                });
            }
            if (porRevisar.length) await this.syncService.avisarProductosPorRevisar(scope.userId, porRevisar).catch(() => undefined);
            for (const connectionId of cuentas) {
                const r = await this.syncService.publishBatchToFalabella({ userId: scope.userId, storeId: scope.storeId }, connectionId, ids);
                console.log(`[AiProcessor] Lote ${batchId} → Falabella: ${r.enviados} enviados, ${r.rechazados?.length ?? 0} rechazados.`);
            }
        } catch (error: any) {
            console.warn(`[AiProcessor] No se pudo publicar el lote ${batchId} en Falabella: ${error?.message}`);
        }
    }
}
