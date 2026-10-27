import { Injectable, Logger } from '@nestjs/common';
import { SyncScope, SyncService } from '../sync/sync.service';
import { FalabellaAutoPrepService, FalabellaPrepReport } from './falabella-auto-prep.service';
import { AiService } from './ai.service';
import { ChannelAttributesService } from './channel-attributes.service';
import { quitarUrls } from './description-html';
import { CuentasElegidas, cuentasParaPublicar } from '../sync/cuentas-elegidas';

export interface LaunchChannelResult {
    marketplace: string;
    /** Cuántas cuentas del canal recibieron la orden de publicar. */
    accounts: number;
    status: 'encolado' | 'omitido' | 'error';
    message: string;
}

export interface LaunchReport {
    channels: LaunchChannelResult[];
    falabella?: FalabellaPrepReport;
    /** Datos de Mercado Libre que la IA tuvo que estimar. */
    estimatedMeli: string[];
}

const CANALES = ['mercadolibre', 'falabella'];
const NOMBRE: Record<string, string> = { mercadolibre: 'Mercado Libre', falabella: 'Falabella' };

/**
 * «Lanzar» un producto: deja listo cada canal y lo publica, sin que la persona tenga que hacer nada más.
 *  - Falabella: categoría, marca contra su catálogo, medidas, todos los atributos y la descripción HTML.
 *  - Mercado Libre: completa los atributos de la categoría (obligatorios y opcionales) con lo que dicen las fotos y el texto.
 * Lo que la IA estimó (medidas, datos obligatorios) queda marcado para revisarlo después desde la ficha.
 */
@Injectable()
export class ProductLaunchService {
    private readonly logger = new Logger(ProductLaunchService.name);

    constructor(
        private readonly sync: SyncService,
        private readonly falabellaPrep: FalabellaAutoPrepService,
        private readonly ai: AiService,
        private readonly canales: ChannelAttributesService,
    ) { }

    /** `elegidas`: las cuentas de cada canal donde la persona quiere publicar; sin ella se usan todas las activas. */
    async lanzar(scope: SyncScope, productId: string, marketplaces: string[], elegidas: CuentasElegidas = {}): Promise<LaunchReport> {
        const pedidos = [...new Set(marketplaces.map((m) => m.toLowerCase()))].filter((m) => CANALES.includes(m));
        const reporte: LaunchReport = { channels: [], estimatedMeli: [] };

        const cuentas = (await this.sync.getConnections(scope.storeId)).filter((c: any) => c.status === 'active');

        for (const canal of pedidos) {
            const activasDelCanal = cuentas.filter((c: any) => c.marketplace === canal);
            const idsAElegir = cuentasParaPublicar(activasDelCanal.map((c: any) => c.id), elegidas[canal]);
            const delCanal = activasDelCanal.filter((c: any) => idsAElegir.includes(c.id));
            if (activasDelCanal.length && !delCanal.length) {
                reporte.channels.push({ marketplace: canal, accounts: 0, status: 'omitido', message: `La cuenta elegida de ${NOMBRE[canal]} ya no está activa: elige otra.` });
                continue;
            }
            if (!delCanal.length) {
                reporte.channels.push({ marketplace: canal, accounts: 0, status: 'omitido', message: `Esta tienda no tiene una cuenta activa de ${NOMBRE[canal]}.` });
                continue;
            }

            // Los canales rechazan una publicación sin precio: se dice antes de gastar IA y de encolar algo que va a fallar.
            const producto = await this.sync.findScopedProduct(scope, productId);
            if (!(Number(producto.price) > 0)) {
                reporte.channels.push({ marketplace: canal, accounts: 0, status: 'error', message: `${NOMBRE[canal]} exige precio: este producto no tiene. Edita el producto, ponle precio y vuelve a pulsar Publicar.` });
                continue;
            }

            try {
                // Preparación propia de cada canal
                if (canal === 'falabella') reporte.falabella = await this.falabellaPrep.preparar(scope, productId, delCanal[0].id);
                if (canal === 'mercadolibre') reporte.estimatedMeli = await this.completarMeli(scope, productId, delCanal[0].id);
            } catch (error: any) {
                this.logger.warn(`Preparación de ${canal} para ${productId}: ${error?.message}`);
                // Si no se pudo preparar, igual se intenta publicar: el motivo exacto queda en la ficha.
            }

            // Falabella rechazaría un producto al que le falta algo que pide: se dice qué falta en vez de fingir que se publica.
            if (canal === 'falabella' && reporte.falabella && !reporte.falabella.listo) {
                reporte.channels.push({
                    marketplace: canal,
                    accounts: 0,
                    status: 'error',
                    message: `Falabella: todavía ${reporte.falabella.motivo}. Complétalo en la Ficha del producto y vuelve a pulsar Publicar.`,
                });
                continue;
            }

            let encoladas = 0;
            let ultimoError = '';
            for (const cuenta of delCanal) {
                try {
                    await this.sync.enqueuePublish(scope, productId, [canal], { [canal]: cuenta.id });
                    encoladas++;
                } catch (error: any) {
                    ultimoError = error?.response?.message ?? error?.message ?? 'error desconocido';
                    if (Array.isArray(ultimoError)) ultimoError = (ultimoError as string[]).join(', ');
                }
            }
            reporte.channels.push(
                encoladas
                    ? { marketplace: canal, accounts: encoladas, status: 'encolado', message: `Publicando en ${NOMBRE[canal]}.` }
                    : { marketplace: canal, accounts: 0, status: /ya está publicado|ya se está publicando/i.test(ultimoError) ? 'omitido' : 'error', message: ultimoError },
            );
        }
        return reporte;
    }

    /** Mercado Libre rechaza una publicación sin sus atributos obligatorios: los que falten se estiman. Devuelve cuáles. */
    private async completarMeli(scope: SyncScope, productId: string, connectionId: string): Promise<string[]> {
        const product = await this.sync.findScopedProduct(scope, productId);
        const attrs: Record<string, any> = { ...((product.aiAttributes as any) || {}) };
        let categoria = (product.marketplaceIds as any)?.mercadolibre_category_id ?? attrs.mercadolibre_category_id;
        if (!categoria) {
            // Sin categoría guardada, Mercado Libre la predice por el título al publicar y rechaza si faltan sus obligatorios:
            // se predice ahora, se guarda y se completan los atributos de esa categoría.
            // Con el token de la cuenta: igual que al publicar, para que la predicción no dependa de una consulta anónima.
            const token = await this.sync.getValidConnectionById(connectionId).then((c) => c.accessToken).catch(() => undefined);
            categoria = await this.sync.resolveMeliCategory(product, token).catch((error: any) => {
                this.logger.warn(`Categoría de Mercado Libre para ${product.sku}: ${error?.message}`);
                return null;
            });
            if (!categoria) return [];
            attrs.mercadolibre_category_id = categoria;
            product.aiAttributes = attrs;
            await this.sync.saveProduct(product);
        }

        // Todos los atributos de la categoría, no solo los obligatorios: los opcionales que se pueden sacar de las fotos o del texto suben la calidad.
        const requisitos = await this.canales.requisitos('mercadolibre', String(categoria), undefined, undefined, undefined, { todos: true });
        const actuales: Record<string, string> = { ...(attrs.mercadolibre_attributes ?? {}) };
        const faltantes = (requisitos ?? []).filter((a) => !String(actuales[a.name] ?? '').trim());
        if (!faltantes.length) return [];

        const medidas = [product.packageWidth, product.packageLength, product.packageHeight].every((v) => v != null)
            ? `${product.packageWidth} x ${product.packageLength} x ${product.packageHeight} cm, ${product.packageWeight ?? '?'} kg`
            : undefined;
        const r = await this.ai.completarAtributos(
            product.aiTitle || product.name,
            product.aiDescription || product.description || product.name,
            faltantes,
            { marca: attrs.brand, color: attrs.color },
            { textoCliente: quitarUrls(product.description), vision: attrs.vision, medidas, sku: product.sku },
        );
        if (!Object.keys(r.values).length) return [];

        const estimated = attrs.estimated ?? { measures: false, attributes: {} };
        product.aiAttributes = {
            ...attrs,
            mercadolibre_attributes: { ...actuales, ...r.values },
            estimated: { ...estimated, attributes: { ...(estimated.attributes ?? {}), mercadolibre: [...new Set([...(estimated.attributes?.mercadolibre ?? []), ...r.estimated])] } },
        };
        await this.sync.saveProduct(product);
        return r.estimated;
    }
}
