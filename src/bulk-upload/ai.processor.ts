import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { AiService } from '../ai/ai.service';
import { ProductsService } from '../products/products.service';
import { SyncService } from '../sync/sync.service';
import { FalabellaAutoPrepService } from '../ai/falabella-auto-prep.service';
import { InternalServerErrorException, Optional } from '@nestjs/common';
import { BatchNotificationService, BatchMeta } from './batch-notification.service';
import { CuentasElegidas, cuentasParaPublicar, leerCuentasElegidas } from '../sync/cuentas-elegidas';
import { CONCURRENCIA_IA } from './concurrencia-cola';
import { BulkBatchService } from './bulk-batch.service';
import { tamanoDeTandaFalabella } from './tanda-falabella';
import { CategoriaUnicaDeLote, TurnoDeCategoria } from './categoria-unica-de-lote';
import { categoriasElegidas } from '../ai/categorias-elegidas';
import { ProductGroupsService } from '../products/product-groups.service';

@Processor('generate-listings-queue', { concurrency: CONCURRENCIA_IA })
export class AiProcessor extends WorkerHost {
    constructor(
        private readonly aiService: AiService,
        private readonly productsService: ProductsService,
        private readonly syncService: SyncService,
        private readonly falabellaPrep: FalabellaAutoPrepService,
        private readonly batchNotification: BatchNotificationService,
        private readonly bulkBatch: BulkBatchService,
        // Opcional: sin él (pruebas, scripts) cada fila se categoriza por su cuenta, como antes.
        @Optional() private readonly categoriaUnica?: CategoriaUnicaDeLote,
        // Productos con variantes de la carga masiva (un trabajo por grupo).
        @Optional() private readonly grupos?: ProductGroupsService,
    ) {
        super();
        console.log(`[AiProcessor] Productos procesados a la vez: ${CONCURRENCIA_IA} (AI_QUEUE_CONCURRENCY)`);
    }

    async process(job: Job<any, any, string>): Promise<any> {
        // «Reintentar» de una carga: reenvía a Falabella los productos que quedaron sin enviar.
        if (job.name === 'enviar-falabella') {
            const { userId, storeId, productIds, cuentas } = job.data;
            await this.enviarAFalabella(job.data.batchId, productIds ?? [], { userId, storeId }, leerCuentasElegidas(cuentas));
            return { status: 'completed', enviados: (productIds ?? []).length };
        }
        if (job.name === 'process-group') return this.procesarGrupo(job);
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

        // Variantes de un mismo producto (mismo «sku_padre»): la categoría se decide UNA vez y las demás filas la usan.
        const grupoClave = String(job.data.grupoClave ?? '').trim();
        let turno: TurnoDeCategoria = { rol: 'solo' };
        if (grupoClave && job.data.batchId && this.categoriaUnica) {
            try { turno = await this.categoriaUnica!.turno(job.data.batchId, grupoClave, String(job.id)); } catch { turno = { rol: 'solo' }; }
        }

        try {
            // 1. Create the product with the resolved image URL (if any). En un reintento ya existe: se retoma sin duplicar.
            // Un producto reenviado desde «Reintentar» pudo haberse creado en la carga anterior.
            const existente = job.attemptsMade > 0 || job.data.reintento ? await this.productsService.findBySku({ userId, storeId }, sku) : null;
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
                // Quien llega después del primero del grupo usa la categoría ya decidida: no se vuelve a categorizar.
                ...(turno.rol === 'seguidor' ? { categoriasElegidas: turno.categorias } : {}),
            });

            // 3. Misma lógica que la creación individual: atributos por canal, medidas y lo visto en las fotos.
            this.productsService.applyAiContent(product, aiContent);
            // El primero del grupo publica sus categorías para las demás variantes.
            if (turno.rol === 'jefe') {
                await this.categoriaUnica!.publicar(job.data.batchId, grupoClave, categoriasElegidas(product.marketplaceIds as any, product.aiAttributes as any)).catch(() => undefined);
            }
            product.status = 'synced';
            // Sin nombre o descripción en el Excel, los arma la IA a partir de las fotos.
            if (!productName) product.name = (product.aiTitle || aiContent.vision?.suggestedName || sku).slice(0, 255);
            if (!description) product.description = product.aiDescription || aiContent.vision?.description || '';
            const updatedProduct = await this.productsService.save(product);

            console.log(`[AiProcessor] ✓ Job ${job.id} done -> Product ${updatedProduct.id}`);

            // Se anota ya en el registro del lote (antes de publicar: el envío por tandas a Falabella busca el producto por su id).
            if (batchMeta) await this.bulkBatch.marcar(batchMeta.batchId, sku, { ok: true, productId: updatedProduct.id });

            // 4. Publicación automática en los canales conectados (los errores no tumban el producto).
            await this.publicar(updatedProduct.id, publishTo, { userId, storeId }, batchMeta?.batchId, cuentas);

            // Track batch progress — notify user when all jobs in this upload are done
            if (batchMeta) {
                const terminado = await this.batchNotification.trackAndNotify(batchMeta, true);
                if (terminado) await this.bulkBatch.cerrar(batchMeta.batchId);
                if (terminado) await this.publicarFalabellaDelLote(batchMeta.batchId, publishTo, { userId, storeId }, cuentas);
            }

            return { status: 'completed', productId: updatedProduct.id };
        } catch (error) {
            console.error(`[AiProcessor] Job ${job.id} failed (intento ${job.attemptsMade + 1}):`, error);
            if (!ultimoIntento) throw new InternalServerErrorException('Error processing AI background job');
            // Si quien decidía la categoría del grupo falló del todo, las demás filas no esperan: se categorizan por su cuenta.
            if (turno.rol === 'jefe') await this.categoriaUnica!.fallo(job.data.batchId, grupoClave).catch(() => undefined);

            // Track failed job too — batch must still complete
            if (batchMeta) {
                await this.bulkBatch.marcar(batchMeta.batchId, sku, { ok: false, error: (error as any)?.message });
                const terminado = await this.batchNotification.trackAndNotify(batchMeta, false);
                if (terminado) await this.bulkBatch.cerrar(batchMeta.batchId);
                if (terminado) await this.publicarFalabellaDelLote(batchMeta.batchId, publishTo, { userId, storeId }, cuentas);
            }

            throw new InternalServerErrorException('Error processing AI background job');
        }
    }

    /**
     * Un producto con variantes de la carga masiva: se crea el grupo con todas sus variantes (en una transacción), la IA lo completa
     * UNA sola vez (categoría, título, atributos, medidas) y se reparte entre las variantes, y se publica como una familia. En el
     * avance del lote cuenta cada variante. Un reintento retoma el grupo ya creado en vez de crearlo otra vez.
     */
    private async procesarGrupo(job: Job<any, any, string>): Promise<any> {
        const d = job.data;
        const scope = { userId: d.userId as string, storeId: d.storeId as string };
        const cuentas = leerCuentasElegidas(d.cuentas);
        const publishTo: string[] = d.publishTo ?? [];
        const skus: string[] = (d.variants ?? []).map((v: any) => v.sku);
        const batchMeta: BatchMeta | undefined = d.batchId ? { batchId: d.batchId, batchTotal: d.batchTotal, userEmail: d.userEmail, jobType: 'Creación masiva de productos' } : undefined;
        const ultimoIntento = job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);
        console.log(`[AiProcessor] Processing job ${job.id}: producto con variantes ${d.parentSku} (${skus.length} variantes)`);

        try {
            if (!this.grupos) throw new Error('los productos con variantes no están disponibles en este proceso');
            const existente = job.attemptsMade > 0 || d.reintento ? await this.grupos.idPorCodigo(d.parentSku, scope) : null;
            // Solo se retoma si es ESTE grupo (mismas variantes): si otra carga tomó el código a la vez, no se completa un grupo ajeno.
            if (existente) {
                const suyas = new Set((await this.grupos.obtener(existente, scope)).variants.map((v) => v.sku.toLowerCase()));
                if (skus.some((s) => !suyas.has(s.toLowerCase()))) throw new Error(`el código ${d.parentSku} ya lo usa otro producto con variantes de la tienda`);
            }
            const grupoId = existente ?? (await this.grupos.crear({
                parentSku: d.parentSku,
                name: d.productName || undefined,
                description: d.description || undefined,
                targetMarketplaces: d.targetMarketplaces,
                axes: d.axes,
                variants: d.variants,
            }, scope)).id;

            const ia = await this.grupos.completarConIA(grupoId, {
                name: d.productName || undefined, description: d.description || undefined, targetMarketplaces: d.targetMarketplaces, estimar: true,
            }, scope);
            if (!ia.ok) throw new Error(ia.motivo ?? 'la IA no pudo completar el producto');

            const vista = await this.grupos.obtener(grupoId, scope);
            const idDe = new Map(vista.variants.map((v) => [v.sku.toLowerCase(), v.id]));
            if (batchMeta) for (const sku of skus) await this.bulkBatch.marcar(batchMeta.batchId, sku, { ok: true, productId: idDe.get(sku.toLowerCase()) });
            console.log(`[AiProcessor] ✓ Job ${job.id} done -> Grupo ${grupoId} (${vista.variants.length} variantes)`);

            await this.publicarGrupo(vista.variants.map((v) => v.id), publishTo, scope, batchMeta?.batchId, cuentas);

            if (batchMeta) {
                const terminado = await this.batchNotification.trackAndNotify(batchMeta, true, skus.length);
                if (terminado) await this.bulkBatch.cerrar(batchMeta.batchId);
                if (terminado) await this.publicarFalabellaDelLote(batchMeta.batchId, publishTo, scope, cuentas);
            }
            return { status: 'completed', groupId: grupoId, variantes: vista.variants.length };
        } catch (error) {
            console.error(`[AiProcessor] Job ${job.id} failed (intento ${job.attemptsMade + 1}):`, error);
            if (!ultimoIntento) throw new InternalServerErrorException('Error processing AI background job');
            if (batchMeta) {
                for (const sku of skus) await this.bulkBatch.marcar(batchMeta.batchId, sku, { ok: false, error: (error as any)?.message });
                const terminado = await this.batchNotification.trackAndNotify(batchMeta, false, skus.length);
                if (terminado) await this.bulkBatch.cerrar(batchMeta.batchId);
                if (terminado) await this.publicarFalabellaDelLote(batchMeta.batchId, publishTo, scope, cuentas);
            }
            throw new InternalServerErrorException('Error processing AI background job');
        }
    }

    /**
     * Publica una familia de variantes. Falabella: todas quedan anotadas JUNTAS para la tanda del lote (una familia nunca se parte entre
     * tandas: separadas, Falabella puede armar familias distintas). Los demás canales: la publicación de familia de siempre.
     */
    private async publicarGrupo(ids: string[], canales: string[], scope: { userId: string; storeId?: string }, batchId?: string, elegidas: CuentasElegidas = {}) {
        if (!scope.storeId || !canales.length || !ids.length) return;
        for (const canal of canales) {
            try {
                if (canal === 'falabella' && batchId) {
                    const esperando = await this.batchNotification.deferPublishFamilia(batchId, 'falabella', ids);
                    for (const id of ids) await this.bulkBatch.falabellaPendiente(batchId, id);
                    const tanda = tamanoDeTandaFalabella(process.env.FALABELLA_BATCH_SIZE);
                    if (tanda && esperando >= tanda) await this.enviarAFalabella(batchId, await this.batchNotification.takeDeferred(batchId, 'falabella', tanda), scope, elegidas);
                    continue;
                }
                for (const connectionId of cuentasParaPublicar(await this.cuentasDe(scope.storeId, canal), elegidas[canal])) {
                    await this.syncService.enqueuePublishFamilia({ userId: scope.userId, storeId: scope.storeId }, ids[0], [canal], { [canal]: connectionId });
                }
            } catch (error: any) {
                console.warn(`[AiProcessor] No se pudo encolar el grupo de ${ids[0]} en ${canal}: ${error?.message}`);
            }
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
                    const esperando = await this.batchNotification.deferPublish(batchId, 'falabella', productId);
                    await this.bulkBatch.falabellaPendiente(batchId, productId);
                    // Con FALABELLA_BATCH_SIZE, cada vez que se juntan los productos de una tanda se envía, sin esperar al final del lote.
                    const tanda = tamanoDeTandaFalabella(process.env.FALABELLA_BATCH_SIZE);
                    if (tanda && esperando >= tanda) await this.enviarAFalabella(batchId, await this.batchNotification.takeDeferred(batchId, 'falabella', tanda), scope, elegidas);
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

    /**
     * Lo que quede por mandar a Falabella al terminar el lote. Lo hace quien cierra el lote. Además de la lista de Redis se
     * toma lo que la base tiene como pendiente: si Redis perdió la lista, no se pierde ningún producto.
     */
    private async publicarFalabellaDelLote(batchId: string, canales: string[], scope: { userId: string; storeId?: string }, elegidas: CuentasElegidas = {}) {
        if (!scope.storeId || !canales.includes('falabella')) return;
        const deRedis = await this.batchNotification.takeDeferred(batchId, 'falabella');
        const deLaBase = await this.bulkBatch.pendientesDeFalabella(batchId);
        await this.enviarAFalabella(batchId, [...new Set([...deRedis, ...deLaBase])], scope, elegidas);
    }

    /** Deja listos para Falabella los productos de una tanda y la envía; cada producto queda anotado como enviado o rechazado. */
    private async enviarAFalabella(batchId: string, ids: string[], scope: { userId: string; storeId?: string }, elegidas: CuentasElegidas = {}) {
        if (!scope.storeId || !ids.length) return;
        try {
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
            const rechazados: { sku: string; motivo: string }[] = [];
            for (const connectionId of cuentas) {
                const r = await this.syncService.publishBatchToFalabella({ userId: scope.userId, storeId: scope.storeId }, connectionId, ids);
                console.log(`[AiProcessor] Lote ${batchId} → Falabella: ${r.enviados} enviados, ${r.rechazados?.length ?? 0} rechazados (tanda de ${ids.length}).`);
                rechazados.push(...(r.rechazados ?? []));
            }
            // Solo si el envío no falló: un producto cuya tanda falló sigue «pendiente» en la base y se reintenta.
            await this.bulkBatch.falabellaResultado(batchId, ids, rechazados);
        } catch (error: any) {
            console.warn(`[AiProcessor] No se pudo publicar el lote ${batchId} en Falabella: ${error?.message}`);
        }
    }
}
