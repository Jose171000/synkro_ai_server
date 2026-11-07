import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import {
    ChannelAuth,
    ChannelClient,
    ChannelListingRow,
    ChannelListingsResult,
    ChannelOrder,
    ChannelOrdersQuery,
    ChannelOrdersResult,
} from '../channels/channel-types';
import { filaDeOfertaRipley, fotosDeRespuestaP11, normalizarClaveDeRipley, normalizarHostDeRipley, normalizarPedidoRipley } from './ripley-mapping';

/** Ripley pagina de a 100 como máximo. */
const PAGINA = 100;
/** Tope de ofertas que se leen de una vez (50 páginas); más que eso se marca como lectura incompleta. */
const MAX_OFERTAS = 5000;
const TIMEOUT_MS = 25_000;
/** Mirakl pide el formato yyyy-MM-dd'T'HH:mm:ss en las fechas de filtro. */
const fechaDeFiltro = (d: Date) => d.toISOString().slice(0, 19);

/** Traduce un error de Ripley (Mirakl) a un mensaje claro en español. */
export function describirErrorRipley(error: any): string {
    const status = error?.response?.status;
    const data = error?.response?.data;
    if (status === 401) return 'Ripley rechazó la clave de API: es incorrecta o ya no vale. Genera una nueva en el portal de vendedor (pulsa tu correo arriba a la derecha) y vuelve a conectar.';
    if (status === 403) return 'Ripley negó el acceso: la clave no tiene permisos para esta operación o la tienda está cerrada.';
    if (status === 404) return 'Ripley no encontró lo pedido. Revisa que la dirección sea la de tu portal (por ejemplo ripleyperu-prod.mirakl.net).';
    if (status === 429) return 'Ripley limitó las peticiones. Inténtalo de nuevo en unos segundos.';
    if (status && status >= 500) return `Ripley tiene un problema en este momento (HTTP ${status}). Inténtalo de nuevo más tarde.`;
    if (typeof data === 'string' && /<html|<!doctype/i.test(data)) return 'Ripley devolvió una página web en vez de datos. Revisa que la dirección sea la de tu portal.';
    if (status >= 300 && status < 400) return 'Ripley redirigió la petición a otra dirección. Revisa que la dirección sea la de tu portal de vendedor.';
    if (!error?.response && (error?.code || error?.request)) return `No se pudo contactar con Ripley (${error?.code || error?.message || 'error de red'}). Revisa la dirección y tu conexión.`;
    const detalle = typeof data?.message === 'string' ? data.message : typeof data?.error === 'string' ? data.error : null;
    return `Error de Ripley${status ? ` (HTTP ${status})` : ''}: ${detalle ?? error?.message ?? 'error desconocido'}`;
}

/**
 * Cliente HTTP de Mercado Ripley (Mirakl). Solo habla con la API: lee la cuenta, las ofertas y los pedidos.
 * Por ahora NO escribe nada en Ripley: aceptar y despachar pedidos se hace en su portal, y el envío de stock y precio
 * (POST /api/offers, que reemplaza la oferta entera) se activará aparte, con pruebas en la tienda real.
 *
 * Documentación: docs/ripley-integracion.md. La clave va tal cual en la cabecera Authorization (sin «Bearer»).
 */
@Injectable()
export class RipleyApiService implements ChannelClient {
    readonly channel = 'ripley' as const;
    private readonly logger = new Logger('RipleyApi');

    private async get<T = any>(auth: ChannelAuth, ruta: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
        // La dirección se valida en cada llamada: la clave nunca sale hacia un sitio que no sea de Mirakl.
        const host = normalizarHostDeRipley(auth.site);
        const clave = normalizarClaveDeRipley(auth.token);
        try {
            const { data } = await axios.get<T>(`https://${host}${ruta}`, {
                params,
                headers: { Authorization: clave, Accept: 'application/json' },
                timeout: TIMEOUT_MS,
                maxRedirects: 0,
                validateStatus: (s) => s >= 200 && s < 300,
            });
            return data;
        } catch (error: any) {
            throw new BadRequestException(describirErrorRipley(error));
        }
    }

    /** Comprueba la clave contra GET /api/account y dice qué tienda es. */
    async verify(auth: ChannelAuth) {
        const cuenta = await this.get<any>(auth, '/api/account');
        const id = cuenta?.shop_id;
        if (id === undefined || id === null || id === '') {
            throw new BadRequestException('Ripley respondió, pero no dijo qué tienda es. Revisa que la dirección sea la de tu portal de vendedor.');
        }
        return {
            accountId: String(id),
            nickname: String(cuenta?.shop_name ?? `Tienda ${id}`).slice(0, 120),
            currency: cuenta?.currency_iso_code ? String(cuenta.currency_iso_code).toUpperCase() : null,
        };
    }

    /** Todas las ofertas de la tienda (OF21), una fila por SKU. */
    async listListings(auth: ChannelAuth): Promise<ChannelListingsResult> {
        const rows: ChannelListingRow[] = [];
        let sinSku = 0;
        let leidas = 0;
        let incompleto = false;
        for (let offset = 0; ; offset += PAGINA) {
            if (offset >= MAX_OFERTAS) { incompleto = true; break; }
            const pagina = await this.get<any>(auth, '/api/offers', { paginate: true, max: PAGINA, offset });
            const ofertas: any[] = Array.isArray(pagina?.offers) ? pagina.offers : [];
            for (const oferta of ofertas) {
                leidas++;
                const fila = filaDeOfertaRipley(oferta);
                if (fila) rows.push(fila); else sinSku++;
            }
            const total = Number(pagina?.total_count);
            if (ofertas.length < PAGINA || (Number.isFinite(total) && offset + PAGINA >= total)) break;
        }
        return { rows, sinSku, productos: leidas, incompleto };
    }

    /**
     * Una foto por producto del catálogo de Ripley (P11, solo lectura): código de producto → dirección de la imagen.
     * Se pide de a 100 códigos. Si Ripley falla en un lote, ese lote queda sin fotos y el resto sigue.
     */
    async fotosDeProductos(auth: ChannelAuth, productSkus: string[]): Promise<Map<string, string>> {
        const fotos = new Map<string, string>();
        const unicos = [...new Set(productSkus.filter(Boolean))];
        for (let i = 0; i < unicos.length; i += PAGINA) {
            try {
                const r = await this.get<any>(auth, '/api/products/offers', { product_ids: unicos.slice(i, i + PAGINA).join(',') });
                for (const [codigo, url] of fotosDeRespuestaP11(r)) fotos.set(codigo, url);
            } catch (error: any) {
                this.logger.warn(`No se pudieron leer las fotos de ${Math.min(PAGINA, unicos.length - i)} productos de Ripley: ${error?.message}`);
            }
        }
        return fotos;
    }

    /** Los pedidos (OR11). Ripley filtra por fecha de actualización; el filtro por creación se completa aquí. */
    async listOrders(auth: ChannelAuth, query: ChannelOrdersQuery): Promise<ChannelOrdersResult> {
        // Un pedido se actualiza después de crearse: pedir desde la fecha de creación (con un día de margen) lo incluye.
        const desde = query.updatedFrom ?? (query.createdFrom ? new Date(query.createdFrom.getTime() - 86_400_000) : undefined);
        const hasta = query.updatedFrom ? undefined : query.createdTo ? new Date(query.createdTo.getTime() + 86_400_000) : undefined;

        const orders: ChannelOrder[] = [];
        let incompleto = false;
        for (let offset = 0; ; offset += PAGINA) {
            if (orders.length >= query.max) { incompleto = true; break; }
            const pagina = await this.get<any>(auth, '/api/orders', {
                paginate: true,
                max: PAGINA,
                offset,
                start_update_date: desde ? fechaDeFiltro(desde) : undefined,
                end_update_date: hasta ? fechaDeFiltro(hasta) : undefined,
            });
            const crudas: any[] = Array.isArray(pagina?.orders) ? pagina.orders : [];
            for (const cruda of crudas) {
                const orden = normalizarPedidoRipley(cruda);
                if (!orden.externalId) continue;
                if (query.createdFrom && orden.orderDate < query.createdFrom) continue;
                if (query.createdTo && orden.orderDate > query.createdTo) continue;
                orders.push(orden);
            }
            const total = Number(pagina?.total_count);
            if (crudas.length < PAGINA || (Number.isFinite(total) && offset + PAGINA >= total)) break;
        }
        orders.sort((a, b) => b.orderDate.getTime() - a.orderDate.getTime());
        return { orders: orders.slice(0, query.max), incompleto };
    }

    /**
     * SOLO LECTURA. Reconocimiento de lo que Ripley dice sobre variantes, categorías y atributos (fase 0 del plan de variantes).
     * No escribe nada ni devuelve la clave. Cada parte se intenta por separado: si Ripley rechaza una, las demás siguen.
     */
    async diagnostico(auth: ChannelAuth): Promise<Record<string, any>> {
        const salida: Record<string, any> = {};
        const intentar = async (nombre: string, fn: () => Promise<any>) => {
            try { salida[nombre] = await fn(); } catch (error: any) { salida[nombre] = { error: error?.message ?? String(error) }; }
        };

        const ofertas: any[] = [];
        await intentar('ofertas', async () => {
            for (let offset = 0; offset < 1000; offset += PAGINA) {
                const pagina = await this.get<any>(auth, '/api/offers', { paginate: true, max: PAGINA, offset });
                const lote: any[] = Array.isArray(pagina?.offers) ? pagina.offers : [];
                ofertas.push(...lote);
                if (lote.length < PAGINA) break;
            }
            const campos = new Set<string>();
            ofertas.forEach((o) => Object.keys(o ?? {}).forEach((k) => campos.add(k)));
            const conProducto = ofertas.filter((o) => typeof o?.product_sku === 'string' && o.product_sku);
            // Familias por base del código de producto: «PMP20001695273-5» → base «PMP20001695273».
            const familias = new Map<string, any[]>();
            for (const o of conProducto) {
                const m = /^(.*?)-(d+)$/.exec(o.product_sku);
                const base = m ? m[1] : o.product_sku;
                const lista = familias.get(base) ?? [];
                lista.push({ shop_sku: o.shop_sku, product_sku: o.product_sku, titulo: o.product_title, categoria: o.category_code ?? o.category_label ?? null });
                familias.set(base, lista);
            }
            const conVarias = [...familias.entries()].filter(([, l]) => l.length > 1);
            return {
                leidas: ofertas.length,
                campos: [...campos].sort(),
                conProductSku: conProducto.length,
                familias: familias.size,
                familiasConVariasOfertas: conVarias.length,
                ofertasEnFamiliasConVarias: conVarias.reduce((s, [, l]) => s + l.length, 0),
                ejemploDeFamilias: conVarias.slice(0, 12).map(([base, l]) => ({ base, ofertas: l })),
                ofertasCrudasDeEjemplo: ofertas.slice(0, 1),
                // Lista corta de todas las ofertas para ver cómo se relacionan sus códigos (s=SKU de la tienda, p=código de producto, c=categoría, a=activa).
                lista: ofertas.map((o) => ({ s: o.shop_sku, p: o.product_sku, c: o.category_code, a: o.active, t: String(o.product_title ?? '').slice(0, 45) })),
                categoriasUsadas: Object.entries(ofertas.reduce((acc: Record<string, number>, o) => { const k = `${o.category_code} ${o.category_label}`; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {})),
            };
        });

        await intentar('categorias', async () => {
            const r = await this.get<any>(auth, '/api/hierarchies');
            const h: any[] = Array.isArray(r?.hierarchies) ? r.hierarchies : [];
            return { total: h.length, muestra: h.slice(0, 8) };
        });
        await intentar('atributos', async () => {
            const r = await this.get<any>(auth, '/api/products/attributes');
            const a: any[] = Array.isArray(r?.attributes) ? r.attributes : [];
            return {
                total: a.length,
                camposDeUnAtributo: Object.keys(a[0] ?? {}),
                deVariante: a.filter((x) => x?.variant === true).slice(0, 40).map((x) => ({ codigo: x.code, etiqueta: x.label, tipo: x.type, categoria: x.hierarchy_code, obligatorio: x.required })),
                muestra: a.slice(0, 5),
            };
        });
        await intentar('atributosDeLasCategoriasUsadas', async () => {
            const codigos = new Set(ofertas.map((o) => o?.category_code).filter(Boolean));
            const r = await this.get<any>(auth, '/api/products/attributes');
            const a: any[] = Array.isArray(r?.attributes) ? r.attributes : [];
            return a
                .filter((x) => codigos.has(x?.hierarchy_code))
                .map((x) => ({ categoria: x.hierarchy_code, codigo: x.code, etiqueta: x.label, tipo: x.type, variante: x.variant === true, obligatorio: x.required === true, nivel: x.requirement_level }));
        });
        await intentar('productoDeUnaOferta', async () => {
            const o = ofertas.find((x) => x?.product_sku);
            if (!o) return { aviso: 'ninguna oferta trae product_sku' };
            const r = await this.get<any>(auth, '/api/products', { product_references: `SKU|${o.product_sku}` });
            return { consultado: o.product_sku, respuesta: r };
        });
        // Sondeo del catálogo de producto (qué formas de consulta acepta Ripley y qué atributos trae cada producto).
        await intentar('sondeoDeCatalogo', async () => {
            const o = ofertas.find((x) => x?.product_sku);
            if (!o) return { aviso: 'sin ofertas' };
            const pruebas: [string, string, Record<string, string>][] = [
                ['P31 MIRAKL_PRODUCT_SKU', '/api/products', { product_references: `MIRAKL_PRODUCT_SKU|${o.product_sku}` }],
                ['P31 SHOP_SKU', '/api/products', { product_references: `SHOP_SKU|${o.shop_sku}` }],
                ['P11 product_ids', '/api/products/offers', { product_ids: o.product_sku }],
            ];
            const r: Record<string, any> = { consultado: { shop_sku: o.shop_sku, product_sku: o.product_sku } };
            for (const [nombre, ruta, params] of pruebas) {
                try { r[nombre] = JSON.stringify(await this.get<any>(auth, ruta, params)).slice(0, 2500); } catch (error: any) { r[nombre] = { error: error?.message }; }
            }
            return r;
        });
        return salida;
    }

    /**
     * Mandar stock o precio a Ripley todavía no está activado: POST /api/offers reemplaza la oferta entera (lo que no se
     * manda se borra), así que se activará después de probarlo con la tienda real. Nunca se llega aquí por las vías normales.
     */
    async setInventory(): Promise<void> {
        this.logger.warn('Se intentó mandar stock a Ripley, que todavía no está activado.');
        throw new BadRequestException('Synkro todavía no envía stock ni precio a Ripley: por ahora solo lee tus ofertas y tus pedidos.');
    }
}
