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
    /** Categoría de Mercado Libre con la que sale el producto; sin `id`, `options` son las recomendadas para que la persona elija. */
    meliCategory?: { id?: string; path?: string; options?: { id: string; path: string }[] };
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

    /**
     * `elegidas`: las cuentas de cada canal donde la persona quiere publicar; sin ella se usan todas las activas.
     * Un producto con variantes se lanza entero: cada variante se prepara y se publica (en Mercado Libre quedan juntas en una
     * familia; en Falabella, bajo un mismo ParentSku si la categoría admite variantes y, si no, como fichas sueltas).
     */
    async lanzar(scope: SyncScope, productId: string, marketplaces: string[], elegidas: CuentasElegidas = {}, opciones: { meliCategoryId?: string } = {}): Promise<LaunchReport> {
        const pedidos = [...new Set(marketplaces.map((m) => m.toLowerCase()))].filter((m) => CANALES.includes(m));
        const reporte: LaunchReport = { channels: [], estimatedMeli: [] };

        const cuentas = (await this.sync.getConnections(scope.storeId)).filter((c: any) => c.status === 'active');
        const familia = await this.sync.familiaDe(scope, productId);

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
            const sinPrecio = familia.find((p) => !(Number(p.price) > 0));
            if (sinPrecio) {
                reporte.channels.push({ marketplace: canal, accounts: 0, status: 'error', message: `${NOMBRE[canal]} exige precio: ${familia.length > 1 ? sinPrecio.sku : 'este producto'} no tiene. Edita el producto, ponle precio y vuelve a pulsar Publicar.` });
                continue;
            }

            // Preparación propia de cada canal, variante por variante.
            let sinCategoria = false;
            let faltaFalabella: string | null = null;
            for (const miembro of familia) {
                try {
                    if (canal === 'falabella') {
                        const prep = await this.falabellaPrep.preparar(scope, miembro.id, delCanal[0].id);
                        if (!reporte.falabella) reporte.falabella = prep;
                        if (!prep.listo && !faltaFalabella) faltaFalabella = familia.length > 1 ? `${miembro.sku} ${prep.motivo}` : String(prep.motivo);
                    }
                    if (canal === 'mercadolibre') {
                        const estimados = await this.completarMeli(scope, miembro.id, delCanal[0].id, reporte, opciones.meliCategoryId);
                        reporte.estimatedMeli = [...new Set([...reporte.estimatedMeli, ...estimados])];
                        if (reporte.meliCategory && !reporte.meliCategory.id) sinCategoria = true;
                    }
                } catch (error: any) {
                    this.logger.warn(`Preparación de ${canal} para ${miembro.sku}: ${error?.message}`);
                    // Si no se pudo preparar, igual se intenta publicar: el motivo exacto queda en la ficha.
                }
            }

            // Sin categoría de Mercado Libre no se publica a ciegas: se devuelven las recomendadas para que la persona elija.
            if (canal === 'mercadolibre' && sinCategoria) {
                reporte.channels.push({
                    marketplace: canal,
                    accounts: 0,
                    status: 'error',
                    message: reporte.meliCategory?.options?.length
                        ? 'No se pudo elegir la categoría de Mercado Libre sola: elige una de las recomendadas.'
                        : 'No se encontró una categoría de Mercado Libre para este producto: revisa el título.',
                });
                continue;
            }

            // Falabella rechazaría un producto al que le falta algo que pide: se dice qué falta en vez de fingir que se publica.
            if (canal === 'falabella' && faltaFalabella) {
                reporte.channels.push({
                    marketplace: canal,
                    accounts: 0,
                    status: 'error',
                    message: `Falabella: todavía ${faltaFalabella}. Complétalo en la Ficha del producto y vuelve a pulsar Publicar.`,
                });
                continue;
            }

            let encoladas = 0;
            let cuentasConEnvio = 0;
            let ultimoError = '';
            for (const cuenta of delCanal) {
                let enEstaCuenta = 0;
                for (const miembro of familia) {
                    try {
                        await this.sync.enqueuePublish(scope, miembro.id, [canal], { [canal]: cuenta.id });
                        enEstaCuenta++;
                    } catch (error: any) {
                        ultimoError = error?.response?.message ?? error?.message ?? 'error desconocido';
                        if (Array.isArray(ultimoError)) ultimoError = (ultimoError as string[]).join(', ');
                    }
                }
                encoladas += enEstaCuenta;
                if (enEstaCuenta) cuentasConEnvio++;
            }
            reporte.channels.push(
                encoladas
                    ? { marketplace: canal, accounts: cuentasConEnvio, status: 'encolado', message: familia.length > 1 ? `Publicando ${familia.length} variantes en ${NOMBRE[canal]}.` : `Publicando en ${NOMBRE[canal]}.` }
                    : { marketplace: canal, accounts: 0, status: /ya está publicado|ya se está publicando/i.test(ultimoError) ? 'omitido' : 'error', message: ultimoError },
            );
        }
        return reporte;
    }

    /** Mercado Libre rechaza una publicación sin sus atributos obligatorios: los que falten se estiman. Devuelve cuáles. */
    private async completarMeli(scope: SyncScope, productId: string, connectionId: string, reporte: LaunchReport, elegida?: string): Promise<string[]> {
        const product = await this.sync.findScopedProduct(scope, productId);
        const attrs: Record<string, any> = { ...((product.aiAttributes as any) || {}) };
        let categoria = (product.marketplaceIds as any)?.mercadolibre_category_id ?? attrs.mercadolibre_category_id;
        if (elegida && elegida !== categoria) {
            // La persona eligió la categoría: manda sobre la que había, y los atributos de la anterior ya no sirven.
            categoria = elegida;
            attrs.mercadolibre_category_id = elegida;
            delete attrs.mercadolibre_attributes;
            product.aiAttributes = attrs;
            await this.sync.saveProduct(product);
        }
        if (!categoria) {
            // Sin categoría guardada, Mercado Libre la predice por el título al publicar y rechaza si faltan sus obligatorios:
            // se predice ahora, se guarda y se completan los atributos de esa categoría.
            // Con el token de la cuenta: igual que al publicar, para que la predicción no dependa de una consulta anónima.
            const token = await this.sync.getValidConnectionById(connectionId).then((c) => c.accessToken).catch(() => undefined);
            categoria = await this.sync.resolveMeliCategory(product, token).catch((error: any) => {
                this.logger.warn(`Categoría de Mercado Libre para ${product.sku}: ${error?.message}`);
                return null;
            });
            if (!categoria) {
                // El título solo no la halla. Las frases de la IA NO deciden: una coincidencia floja acabó poniendo un desmenuzador en
                // «Detergentes». Solo sirven para ofrecer opciones, y la persona elige.
                const frases = [product.aiTitle || product.name, ...(await this.ai.consultasDeCategoria(product.aiTitle || product.name, product.aiDescription || product.description || ''))];
                reporte.meliCategory = { options: await this.sync.suggestMeliCategories(frases, token) };
                return [];
            }
            attrs.mercadolibre_category_id = categoria;
            product.aiAttributes = attrs;
            await this.sync.saveProduct(product);
        }
        const ruta = await this.sync.meliCategoryPath(String(categoria));
        // Una categoría de coleccionismo casi nunca es la de un producto nuevo (un perchero moderno acabó en «Antigüedades»):
        // si salió sola no se publica ahí, se ofrecen las demás y la persona elige. Si la eligió ella, se respeta.
        if (!elegida && /^antig[uü]edades/i.test(ruta)) {
            const token = await this.sync.getValidConnectionById(connectionId).then((c) => c.accessToken).catch(() => undefined);
            const frases = [product.aiTitle || product.name, ...(await this.ai.consultasDeCategoria(product.aiTitle || product.name, product.aiDescription || product.description || '').catch(() => [] as string[]))];
            const opciones = (await this.sync.suggestMeliCategories(frases, token)).filter((o) => !/^antig[uü]edades/i.test(o.path));
            reporte.meliCategory = { options: opciones };
            return [];
        }
        reporte.meliCategory = { id: String(categoria), path: ruta };

        // Todos los atributos de la categoría, no solo los obligatorios: los opcionales que se pueden sacar de las fotos o del texto suben la calidad.
        const requisitos = await this.canales.requisitos('mercadolibre', String(categoria), undefined, undefined, undefined, { todos: true });
        const actuales: Record<string, string> = { ...(attrs.mercadolibre_attributes ?? {}) };
        // Un campo numérico guardado con texto («3 niveles») hace que Mercado Libre rechace la publicación: se borra y se vuelve a completar.
        let limpiado = false;
        for (const a of requisitos ?? []) {
            const v = String(actuales[a.name] ?? '').trim();
            if (a.valueType === 'number' && v && !/^-?\d+(\.\d+)?$/.test(v)) { delete actuales[a.name]; limpiado = true; }
        }
        const faltantes = (requisitos ?? []).filter((a) => !String(actuales[a.name] ?? '').trim());

        let nuevos: Record<string, string> = {};
        let estimados: string[] = [];
        if (faltantes.length) {
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
            nuevos = r.values;
            estimados = r.estimated;
        }

        const todos = { ...actuales, ...nuevos };
        // Vender por «Unidad» obliga a decir cuántas vienen en el envase: una.
        const pideUnidades = (requisitos ?? []).some((a) => a.name === 'UNITS_PER_PACK');
        if (pideUnidades && /^unidad(es)?$/i.test(String(todos.SALE_FORMAT ?? '').trim()) && !String(todos.UNITS_PER_PACK ?? '').trim()) {
            todos.UNITS_PER_PACK = '1';
            nuevos.UNITS_PER_PACK = '1';
        }
        if (!Object.keys(nuevos).length && !limpiado) return [];

        const estimated = attrs.estimated ?? { measures: false, attributes: {} };
        product.aiAttributes = {
            ...attrs,
            mercadolibre_attributes: todos,
            estimated: { ...estimated, attributes: { ...(estimated.attributes ?? {}), mercadolibre: [...new Set([...(estimated.attributes?.mercadolibre ?? []), ...estimados])] } },
        };
        await this.sync.saveProduct(product);
        return estimados;
    }
}

