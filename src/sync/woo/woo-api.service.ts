import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import {
    ChannelAuth, ChannelClient, ChannelListingRow, ChannelListingsResult,
    ChannelOrder, ChannelOrdersQuery, ChannelOrdersResult,
} from '../channels/channel-types';
import { filasDeProductoWoo, normalizarPedidoWoo } from './woo-mapping';

const MAX_PRODUCTOS = 5000;
const MAX_PAGINAS_VARIACIONES = 20;
const CONCURRENCIA = 4;

const texto = (v: any): string | null => {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s ? s : null;
};

/**
 * Deja la dirección de la tienda en su forma canónica: https://dominio.com
 * Acepta que la peguen sin protocolo, con barra final o con rutas del panel
 * (/wp-admin/...).
 */
export function normalizarSitioWoo(site: string): string {
    const crudo = String(site ?? '').trim();
    const mensaje = 'Escribe la dirección de tu tienda, por ejemplo https://mitienda.com';
    if (!crudo) throw new BadRequestException(mensaje);

    let url: URL;
    try {
        url = new URL(/^https?:\/\//i.test(crudo) ? crudo : `https://${crudo}`);
    } catch {
        throw new BadRequestException(mensaje);
    }
    const host = url.hostname.toLowerCase();
    const local = host === 'localhost' || host === '127.0.0.1';
    if (!host || !/^[a-z0-9.-]+$/.test(host) || (!host.includes('.') && !local)) {
        throw new BadRequestException(mensaje);
    }
    if (url.protocol !== 'https:' && !local) {
        throw new BadRequestException('La tienda debe usar https. Escribe la dirección completa, por ejemplo https://mitienda.com');
    }

    // Se descartan las rutas del panel y de la API; una tienda en subcarpeta conserva la suya.
    const ruta = url.pathname
        .replace(/\/(wp-admin|wp-json|wp-login\.php)(\/.*)?$/i, '')
        .replace(/\/+$/, '');
    return `${url.protocol}//${url.host.toLowerCase()}${ruta}`;
}

/** Qué página devolvió la tienda en lugar de datos: el título suele delatar al firewall (Cloudflare, Wordfence, Imunify…). */
export function resumenHtml(data: any, status?: number): string {
    const cuerpo = typeof data === 'string' ? data : '';
    const titulo = cuerpo.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim();
    return `HTTP ${status ?? '?'}${titulo ? `, página «${titulo}»` : ''}`;
}

/** Traduce un fallo de WooCommerce a un mensaje claro en español. */
export function describirErrorWoo(error: any): string {
    const status = error?.response?.status;
    const data = error?.response?.data;
    const cabecera = String(error?.response?.headers?.['content-type'] ?? '');
    const esHtml = typeof data === 'string'
        && (/<\s*(!doctype|html|body)/i.test(data) || /text\/html/i.test(cabecera));

    if (error?.noJson || esHtml) {
        const detalle = error?.htmlResumen ?? resumenHtml(data, status);
        return `La tienda respondió con una página web en lugar de datos de WooCommerce (${detalle}). Suele pasar por un firewall o plugin de seguridad que bloquea la API desde servidores externos, o porque la dirección no es la de la tienda. Permite las llamadas a /wp-json/ y revisa la URL.`;
    }
    if (status === 401 || status === 403) {
        return 'WooCommerce rechazó las claves. Revisa que la Consumer Key y el Secret sean de lectura y escritura';
    }
    if (status === 404) {
        return 'No se encontró la API de WooCommerce en esa dirección. Comprueba la URL y que WooCommerce esté activo (y los enlaces permanentes no estén en «Simple»)';
    }
    const mensaje = String(error?.message ?? '');
    const codigo = String(error?.code ?? '');
    const sinRespuesta = !status;
    if (sinRespuesta && (['ECONNREFUSED', 'ENOTFOUND', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET'].includes(codigo) || /timeout/i.test(mensaje))) {
        return 'No se pudo conectar con la tienda. Comprueba la dirección, que el sitio esté en línea y que no bloquee las conexiones externas.';
    }
    if (sinRespuesta && /certificate|ssl|self.signed/i.test(mensaje)) {
        return 'No se pudo establecer una conexión segura con la tienda: el certificado SSL no es válido.';
    }
    if (status) {
        const detalle = data && typeof data === 'object' ? texto(data.message) : null;
        return `Error de WooCommerce (HTTP ${status})${detalle ? `: ${detalle}` : ''}`;
    }
    return `No se pudo comunicar con WooCommerce: ${texto(mensaje) ?? 'error desconocido'}`;
}

@Injectable()
export class WooApiService implements ChannelClient {
    readonly channel = 'woocommerce' as const;

    private cliente(auth: ChannelAuth): AxiosInstance {
        const sitio = normalizarSitioWoo(auth.site);
        return axios.create({
            baseURL: `${sitio}/wp-json/wc/v3`,
            timeout: 20000,
            auth: { username: auth.token, password: auth.secret ?? '' },
            headers: { 'User-Agent': 'Synkro-AI' },
        });
    }

    /** Ejecuta una llamada y convierte cualquier fallo en un mensaje claro. */
    private async llamar(fn: () => Promise<{ data: any; headers?: any }>): Promise<{ data: any; paginas: number }> {
        try {
            const res = await fn();
            if (typeof res.data === 'string') {
                // Una página HTML con código 200: el firewall o la web respondió en lugar de la API.
                throw Object.assign(new Error('Respuesta no JSON'), { noJson: true, htmlResumen: resumenHtml(res.data, (res as any).status) });
            }
            const paginas = Number(res.headers?.['x-wp-totalpages']);
            return { data: res.data, paginas: Number.isFinite(paginas) && paginas > 0 ? paginas : 1 };
        } catch (e: any) {
            if (e instanceof HttpException) throw e;
            throw new BadRequestException(describirErrorWoo(e));
        }
    }

    private async leerMoneda(http: AxiosInstance): Promise<string | null> {
        try {
            const { data } = await this.llamar(() => http.get('/settings/general/woocommerce_currency'));
            return texto(data?.value) ?? texto(data?.default);
        } catch {
            return null;
        }
    }

    async verify(auth: ChannelAuth) {
        const sitio = normalizarSitioWoo(auth.site);
        const http = this.cliente(auth);
        await this.llamar(() => http.get('/products', { params: { per_page: 1 } }));
        const currency = await this.leerMoneda(http);
        const host = new URL(sitio).host.toLowerCase();
        return { accountId: host, nickname: host, currency };
    }

    async listListings(auth: ChannelAuth): Promise<ChannelListingsResult> {
        const http = this.cliente(auth);
        const currency = await this.leerMoneda(http);

        const productos: any[] = [];
        let incompleto = false;
        let pagina = 1;
        let total = 1;
        while (pagina <= total) {
            const { data, paginas } = await this.llamar(() =>
                http.get('/products', { params: { per_page: 100, page: pagina, status: 'any' } }));
            total = paginas;
            productos.push(...(Array.isArray(data) ? data : []));
            if (productos.length >= MAX_PRODUCTOS) {
                incompleto = productos.length > MAX_PRODUCTOS || pagina < total;
                productos.length = Math.min(productos.length, MAX_PRODUCTOS);
                break;
            }
            pagina++;
        }

        // De a pocos a la vez para no saturar una tienda con hosting modesto.
        const rows: ChannelListingRow[] = [];
        let sinSku = 0;
        for (let i = 0; i < productos.length; i += CONCURRENCIA) {
            const lote = productos.slice(i, i + CONCURRENCIA);
            const resultados = await Promise.all(lote.map(async p => {
                const variaciones = String(p?.type).toLowerCase() === 'variable' && p?.variations?.length
                    ? await this.leerVariaciones(http, p.id)
                    : [];
                return filasDeProductoWoo(p, variaciones, currency);
            }));
            for (const r of resultados) {
                rows.push(...r.rows);
                sinSku += r.sinSku;
            }
        }
        return { rows, sinSku, productos: productos.length, incompleto };
    }

    private async leerVariaciones(http: AxiosInstance, productoId: number | string): Promise<any[]> {
        const todas: any[] = [];
        let pagina = 1;
        let total = 1;
        while (pagina <= total && pagina <= MAX_PAGINAS_VARIACIONES) {
            const { data, paginas } = await this.llamar(() =>
                http.get(`/products/${productoId}/variations`, { params: { per_page: 100, page: pagina } }));
            total = paginas;
            todas.push(...(Array.isArray(data) ? data : []));
            pagina++;
        }
        return todas;
    }

    async setInventory(
        auth: ChannelAuth,
        target: { externalId: string; variationId: string | null },
        values: { stock: number; price?: number | null },
    ): Promise<void> {
        const http = this.cliente(auth);
        const stock = Math.max(0, Math.trunc(values.stock));
        const ruta = target.variationId
            ? `/products/${target.externalId}/variations/${target.variationId}`
            : `/products/${target.externalId}`;
        const cuerpo = {
            manage_stock: true,
            stock_quantity: stock,
            stock_status: stock > 0 ? 'instock' : 'outofstock',
            ...(values.price != null ? { regular_price: values.price.toFixed(2) } : {}),
        };
        await this.llamar(() => http.put(ruta, cuerpo));
    }

    async listOrders(auth: ChannelAuth, query: ChannelOrdersQuery): Promise<ChannelOrdersResult> {
        const http = this.cliente(auth);
        const params: Record<string, any> = {
            per_page: 100,
            orderby: 'date',
            order: 'desc',
            dates_are_gmt: true,
        };
        if (query.createdFrom) params.after = query.createdFrom.toISOString();
        if (query.createdTo) params.before = query.createdTo.toISOString();
        if (query.updatedFrom) params.modified_after = query.updatedFrom.toISOString();

        const orders: ChannelOrder[] = [];
        let incompleto = false;
        let pagina = 1;
        let total = 1;
        while (pagina <= total) {
            const { data, paginas } = await this.llamar(() =>
                http.get('/orders', { params: { ...params, page: pagina } }));
            total = paginas;
            for (const p of Array.isArray(data) ? data : []) orders.push(normalizarPedidoWoo(p));
            if (orders.length >= query.max) {
                incompleto = orders.length > query.max || pagina < total;
                orders.length = Math.min(orders.length, query.max);
                break;
            }
            pagina++;
        }
        return { orders, incompleto };
    }
}
