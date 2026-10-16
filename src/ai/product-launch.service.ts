import { Injectable, Logger } from '@nestjs/common';
import { SyncScope, SyncService } from '../sync/sync.service';
import { FalabellaAutoPrepService, FalabellaPrepReport } from './falabella-auto-prep.service';
import { AiService } from './ai.service';
import { ChannelAttributesService } from './channel-attributes.service';

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
 *  - Mercado Libre: completa los atributos obligatorios que faltaban.
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

    async lanzar(scope: SyncScope, productId: string, marketplaces: string[]): Promise<LaunchReport> {
        const pedidos = [...new Set(marketplaces.map((m) => m.toLowerCase()))].filter((m) => CANALES.includes(m));
        const reporte: LaunchReport = { channels: [], estimatedMeli: [] };

        const cuentas = (await this.sync.getConnections(scope.storeId)).filter((c: any) => c.status === 'active');

        for (const canal of pedidos) {
            const delCanal = cuentas.filter((c: any) => c.marketplace === canal);
            if (!delCanal.length) {
                reporte.channels.push({ marketplace: canal, accounts: 0, status: 'omitido', message: `Esta tienda no tiene una cuenta activa de ${NOMBRE[canal]}.` });
                continue;
            }

            try {
                // Preparación propia de cada canal
                if (canal === 'falabella') reporte.falabella = await this.falabellaPrep.preparar(scope, productId, delCanal[0].id);
                if (canal === 'mercadolibre') reporte.estimatedMeli = await this.completarMeli(scope, productId);
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
                    : { marketplace: canal, accounts: 0, status: /ya está publicado/i.test(ultimoError) ? 'omitido' : 'error', message: ultimoError },
            );
        }
        return reporte;
    }

    /** Mercado Libre rechaza una publicación sin sus atributos obligatorios: los que falten se estiman. Devuelve cuáles. */
    private async completarMeli(scope: SyncScope, productId: string): Promise<string[]> {
        const product = await this.sync.findScopedProduct(scope, productId);
        const attrs: Record<string, any> = { ...((product.aiAttributes as any) || {}) };
        const categoria = (product.marketplaceIds as any)?.mercadolibre_category_id ?? attrs.mercadolibre_category_id;
        if (!categoria) return [];

        const requisitos = await this.canales.requisitos('mercadolibre', String(categoria));
        const actuales: Record<string, string> = { ...(attrs.mercadolibre_attributes ?? {}) };
        const faltantes = (requisitos ?? []).filter((a) => a.isRequired && !String(actuales[a.name] ?? '').trim());
        if (!faltantes.length) return [];

        const r = await this.ai.completarAtributos(product.aiTitle || product.name, product.aiDescription || product.description || product.name, faltantes, { marca: attrs.brand, color: attrs.color });
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
