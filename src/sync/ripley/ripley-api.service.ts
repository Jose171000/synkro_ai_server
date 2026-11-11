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
import { armarOfertaParaEnviar } from './ripley-oferta';
import type { AtributoRipley, JerarquiaRipley, ListaRipley } from './ripley-categorias';
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
 * Cliente HTTP de Mercado Ripley (Mirakl). Lee la cuenta, las ofertas y los pedidos. Lo único que escribe es el stock y el precio de
 * una oferta (POST /api/offers, que reemplaza la oferta entera: ver ripley-oferta.ts), y solo si EcommerceSyncService lo permite
 * (RIPLEY_PUSH_ENABLED + RIPLEY_PUSH_SKUS). Aceptar y despachar pedidos se hace en su portal.
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
     * SOLO LECTURA. Para publicar productos: busca categorías de Ripley por nombre (o toma un código) y trae los atributos de cada una
     * (cuáles son obligatorios, cuáles definen la variante, su tipo) con los valores permitidos de las listas (VL11) que usan.
     * Nada se escribe y la clave no sale en la respuesta.
     */
    async catalogoDeCategoria(auth: ChannelAuth, filtro: { buscar?: string; codigo?: string; conValores?: boolean; buscarValor?: string; lista?: string }): Promise<Record<string, any>> {
        const r = await this.get<any>(auth, '/api/hierarchies');
        const todas: any[] = Array.isArray(r?.hierarchies) ? r.hierarchies : [];
        const quitarTildes = (t: unknown) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        const q = quitarTildes(filtro.buscar);
        const elegidas = filtro.codigo
            ? todas.filter((h) => h?.code === filtro.codigo)
            : q ? todas.filter((h) => quitarTildes(h?.label).includes(q) || quitarTildes(h?.code).includes(q)) : [];
        const salida: Record<string, any> = {
            totalCategorias: todas.length,
            camposDeCategoria: Object.keys(todas[0] ?? {}),
            coinciden: elegidas.length,
            categorias: elegidas.slice(0, 40).map((h) => ({ codigo: h.code, nombre: h.label, nivel: h.level, padre: h.parent_code ?? null })),
        };
        // Los atributos solo se piden cuando la búsqueda se acotó a pocas categorías.
        if (elegidas.length && elegidas.length <= 3) {
            const a = await this.get<any>(auth, '/api/products/attributes');
            const todos: any[] = Array.isArray(a?.attributes) ? a.attributes : [];
            const codigos = new Set(elegidas.map((h) => h.code));
            const deLaCategoria = todos.filter((x) => codigos.has(x?.hierarchy_code));
            const listas = new Set(deLaCategoria.map((x) => x?.type_parameter).filter((v) => typeof v === 'string' && v));
            const valores: Record<string, any> = {};
            if (filtro.conValores) {
                const texto = quitarTildes(filtro.buscarValor);
                for (const lista of [...listas].filter((l) => !filtro.lista || l === filtro.lista).slice(0, 25)) {
                    try {
                        const v = await this.get<any>(auth, '/api/values_lists', { code: String(lista) });
                        const filas: any[] = (Array.isArray(v?.values_lists) ? v.values_lists : [])[0]?.values ?? [];
                        // Con un texto de búsqueda se devuelven SOLO los valores que lo contienen (hasta 40): sirve para comprobar si
                        // «Loncheras» o «Marrón» existen de verdad en la lista cerrada de Ripley.
                        const elegidos = texto ? filas.filter((f) => quitarTildes(f.label).includes(texto) || quitarTildes(f.code).includes(texto)).slice(0, 40) : filas.slice(0, 30);
                        valores[String(lista)] = { total: filas.length, coinciden: texto ? elegidos.length : undefined, muestra: elegidos.map((f) => ({ codigo: f.code, nombre: f.label })) };
                    } catch (error: any) { valores[String(lista)] = { error: error?.message }; }
                }
            }
            salida.camposDeUnAtributo = Object.keys(deLaCategoria[0] ?? {});
            salida.atributos = deLaCategoria.map((x) => ({
                categoria: x.hierarchy_code, codigo: x.code, etiqueta: x.label, tipo: x.type, lista: x.type_parameter ?? null,
                obligatorio: x.required === true, nivel: x.requirement_level ?? null, variante: x.variant === true, descripcion: String(x.description ?? '').slice(0, 160),
            }));
            if (filtro.conValores) salida.valoresDeListas = valores;
        }
        return salida;
    }

    /**
     * SOLO LECTURA. Todo el catálogo de Ripley que hace falta para publicar: el árbol de categorías (H11), los atributos de cada
     * una (PM11) y las listas cerradas de valores que esos atributos usan (VL11). Es el mismo para todas las tiendas.
     */
    async leerCatalogo(auth: ChannelAuth): Promise<{ jerarquias: JerarquiaRipley[]; atributos: AtributoRipley[]; listas: ListaRipley[] }> {
        const h = await this.get<any>(auth, '/api/hierarchies');
        const a = await this.get<any>(auth, '/api/products/attributes');
        const jerarquias: JerarquiaRipley[] = Array.isArray(h?.hierarchies) ? h.hierarchies : [];
        const atributos: AtributoRipley[] = Array.isArray(a?.attributes) ? a.attributes : [];

        const usadas = new Set(atributos.filter((x) => x?.type === 'LIST' && x?.type_parameter).map((x) => String(x.type_parameter)));
        const todas = await this.get<any>(auth, '/api/values_lists');
        const listas: ListaRipley[] = (Array.isArray(todas?.values_lists) ? todas.values_lists : []).filter((l: ListaRipley) => l?.code && usadas.has(String(l.code)));
        // Si Ripley no trae los valores en el listado general, se piden lista por lista.
        for (const lista of listas) {
            if ((lista.values ?? []).length > 0) continue;
            try {
                const v = await this.get<any>(auth, '/api/values_lists', { code: String(lista.code) });
                lista.values = (Array.isArray(v?.values_lists) ? v.values_lists : [])[0]?.values ?? [];
            } catch (error: any) {
                this.logger.warn(`No se pudo leer la lista ${lista.code} de Ripley: ${error?.message}`);
            }
        }
        return { jerarquias, atributos, listas };
    }

    private async post<T = any>(auth: ChannelAuth, ruta: string, cuerpo: unknown): Promise<T> {
        const host = normalizarHostDeRipley(auth.site);
        const clave = normalizarClaveDeRipley(auth.token);
        try {
            const { data } = await axios.post<T>(`https://${host}${ruta}`, cuerpo, {
                headers: { Authorization: clave, Accept: 'application/json', 'Content-Type': 'application/json' },
                timeout: TIMEOUT_MS,
                maxRedirects: 0,
                validateStatus: (s) => s >= 200 && s < 300,
            });
            return data;
        } catch (error: any) {
            throw new BadRequestException(describirErrorRipley(error));
        }
    }

    /** La oferta tal como está hoy en Ripley (OF21 filtrando por SKU). Solo lectura. */
    async ofertaPorSku(auth: ChannelAuth, sku: string): Promise<any> {
        const r = await this.get<any>(auth, '/api/offers', { sku });
        const ofertas: any[] = Array.isArray(r?.offers) ? r.offers : [];
        const oferta = ofertas.find((o) => o?.shop_sku === sku);
        if (!oferta) throw new BadRequestException(`Ripley no tiene una oferta con el SKU «${sku}» en esta cuenta.`);
        return oferta;
    }

    /**
     * OF01: envía un CSV de «Productos y ofertas» (crea el producto en el catálogo y su oferta). Escribe en el catálogo REAL de la
     * tienda: quien llama debe haber comprobado el interruptor de publicación y la confirmación de la persona.
     * Devuelve los dos números para seguirlo: `importId` (ofertas, OF02) y `productImportId` (productos, P42).
     */
    async importarProductosYOfertas(auth: ChannelAuth, csv: string): Promise<{ importId: string | number; productImportId: string | number | null }> {
        const host = normalizarHostDeRipley(auth.site);
        const clave = normalizarClaveDeRipley(auth.token);
        const form = new FormData();
        form.append('file', new Blob([csv], { type: 'text/csv; charset=utf-8' }), 'synkro-productos.csv');
        form.append('import_mode', 'NORMAL');
        form.append('with_products', 'true');
        let data: any;
        try {
            ({ data } = await axios.post(`https://${host}/api/offers/imports`, form, {
                headers: { Authorization: clave, Accept: 'application/json' },
                timeout: 60_000,
                maxRedirects: 0,
                maxBodyLength: Infinity,
                validateStatus: (s) => s >= 200 && s < 300,
            }));
        } catch (error: any) {
            throw new BadRequestException(describirErrorRipley(error));
        }
        if (data?.import_id === undefined || data?.import_id === null) throw new BadRequestException('Ripley recibió el archivo pero no dio el número de importación.');
        this.logger.log(`Ripley: archivo de productos enviado (importación de ofertas ${data.import_id}, de productos ${data?.product_import_id ?? 'sin dato'}).`);
        return { importId: data.import_id, productImportId: data?.product_import_id ?? null };
    }

    /** Cómo va la importación de PRODUCTOS (P42). Solo lectura. */
    async estadoDeProductos(auth: ChannelAuth, productImportId: number | string): Promise<any> {
        return this.get<any>(auth, `/api/products/imports/${encodeURIComponent(String(productImportId))}`);
    }

    /** Las primeras líneas de un reporte de errores en texto (OF03 de ofertas o P47 de productos). Nunca lanza. */
    async reporteDeErrores(auth: ChannelAuth, tipo: 'ofertas' | 'productos', id: number | string, lineas = 12): Promise<string[]> {
        try {
            const host = normalizarHostDeRipley(auth.site);
            const ruta = tipo === 'ofertas'
                ? `/api/offers/imports/${encodeURIComponent(String(id))}/error_report`
                : `/api/products/imports/${encodeURIComponent(String(id))}/transformation_error_report`;
            const { data } = await axios.get(`https://${host}${ruta}`, {
                headers: { Authorization: normalizarClaveDeRipley(auth.token) },
                timeout: TIMEOUT_MS,
                maxRedirects: 0,
                responseType: 'text',
                transformResponse: (d) => d,
                validateStatus: (s) => s >= 200 && s < 300,
            });
            return String(data ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, lineas).map((l) => l.slice(0, 400));
        } catch {
            return [];
        }
    }

    /** Cómo va una importación de ofertas (OF02). */
    async estadoDeImportacion(auth: ChannelAuth, importId: number | string): Promise<any> {
        return this.get<any>(auth, `/api/offers/imports/${encodeURIComponent(String(importId))}`);
    }

    /** Las primeras líneas del reporte de errores de una importación (OF03; viene como archivo). Nunca lanza. */
    private async erroresDeImportacion(auth: ChannelAuth, importId: number | string): Promise<string> {
        try {
            const host = normalizarHostDeRipley(auth.site);
            const { data } = await axios.get(`https://${host}/api/offers/imports/${encodeURIComponent(String(importId))}/error_report`, {
                headers: { Authorization: normalizarClaveDeRipley(auth.token) },
                timeout: TIMEOUT_MS,
                maxRedirects: 0,
                responseType: 'text',
                transformResponse: (d) => d,
                validateStatus: (s) => s >= 200 && s < 300,
            });
            return String(data ?? '').split(/\r?\n/).slice(0, 4).join(' | ').slice(0, 400);
        } catch {
            return '';
        }
    }

    /**
     * Cambia el stock (y el precio, si se indica) de UNA oferta. Lee la oferta actual, la reescribe completa solo con esos
     * cambios (OF24 reemplaza la oferta entera) y comprueba cómo terminó la importación. Si algo no cuadra, lanza y no envía.
     * Quien llama (EcommerceSyncService) ya comprobó el interruptor y la lista de SKU permitidos.
     */
    async setInventory(
        auth: ChannelAuth,
        target: { externalId: string; variationId: string | null; sku?: string },
        values: { stock: number | null; price?: number | null; descuento?: { precio: number | null; desde?: string | null; hasta?: string | null } },
    ): Promise<void> {
        const sku = target.sku;
        if (!sku) throw new BadRequestException('Falta el SKU para mandar el stock a Ripley.');
        const actual = await this.ofertaPorSku(auth, sku);
        // Nunca se escribe sobre una oferta distinta a la que está enlazada.
        if (target.externalId && String(actual.offer_id) !== String(target.externalId)) {
            throw new BadRequestException(`El SKU «${sku}» ahora apunta a otra oferta de Ripley que la enlazada. No se envió nada.`);
        }
        let oferta: Record<string, any>;
        try { oferta = armarOfertaParaEnviar(actual, { stock: values.stock, price: values.price, descuento: values.descuento }); }
        catch (error: any) { throw new BadRequestException(error?.message ?? 'No se pudo preparar la oferta para Ripley.'); }

        const r = await this.post<any>(auth, '/api/offers', { offers: [oferta] });
        const importId = r?.import_id;
        if (importId === undefined || importId === null) throw new BadRequestException('Ripley recibió el cambio pero no dio el número de importación.');
        this.logger.log(`Ripley ${sku}: enviado stock ${oferta.quantity}, precio ${oferta.price}${oferta.discount ? ` y descuento ${oferta.discount.price}` : ' sin descuento'} (importación ${importId}).`);

        // Una sola comprobación a los pocos segundos (Mirakl pide no consultar más de una vez por minuto).
        await new Promise((resolve) => setTimeout(resolve, 8000));
        let estado: any;
        try { estado = await this.estadoDeImportacion(auth, importId); } catch { return; }
        if (estado?.status === 'FAILED' || Number(estado?.lines_in_error) > 0) {
            const detalle = estado?.has_error_report ? await this.erroresDeImportacion(auth, importId) : '';
            throw new BadRequestException(`Ripley rechazó el cambio de ${sku} (importación ${importId})${detalle ? `: ${detalle}` : estado?.reason_status ? `: ${estado.reason_status}` : ''}.`);
        }
        this.logger.log(`Ripley ${sku}: importación ${importId} en estado ${estado?.status ?? 'desconocido'}.`);
    }
}
