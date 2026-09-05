import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { buildSignedQuery, falabellaTimestamp } from './falabella-signature';
import { buildProductFeedXml, escapeXml, FalabellaProductInput } from './falabella-product-xml';

/** Lo que hace falta para hablar con la cuenta de un vendedor. */
/** Publicaciones por página al recorrer el catálogo. */
const PRODUCTOS_POR_PAGINA = 100;

/** Tope de páginas, para no encadenar llamadas sin fin. */
const MAX_PAGINAS = 50;

/** Tope de publicaciones en una sola lectura. */
const MAX_PRODUCTOS = 5000;

/** Respiro entre páginas: Falabella corta a las 50 llamadas seguidas. */
const PAUSA_ENTRE_PAGINAS_MS = 400;

export interface FalabellaCredentials {
    /** El UserID del Seller Center: es el correo de la cuenta. */
    userId: string;
    apiKey: string;
}

export interface FalabellaBrand {
    BrandId: number;
    Name: string;
    GlobalIdentifier?: string;
}

export interface FalabellaFeedStatus {
    feedId: string;
    status: string;
    action: string;
    totalRecords: number;
    processedRecords: number;
    failedRecords: number;
    errors: { sku?: string; message: string }[];
}

export interface FalabellaCategory {
    id: string;
    name: string;
    /** Ruta completa, para distinguir dos categorías que se llaman igual. */
    path: string;
}

export interface FalabellaAttribute {
    /** Nombre técnico, en minúsculas con guion bajo (ej. tipo_automotriz). */
    name: string;
    /** Etiqueta exacta que hay que usar en el XML (ej. TipoAutomotriz). */
    feedName: string;
    /** Nombre en castellano, el que ve una persona. */
    label: string;
    isMandatory: boolean;
    inputType: string;
    /** Valores admitidos, cuando el atributo es una lista cerrada. */
    options: string[];
}

export interface FalabellaOrderItem {
    OrderItemId: string;
    /** SKU del vendedor: es el que casa con nuestros productos. */
    Sku: string;
    ShopSku?: string;
    Name: string;
    Status?: string;
    ItemPrice?: string;
    PaidPrice?: string;
}

/**
 * Precio, stock y estado NO viven en la raíz del producto sino aquí dentro.
 * Comprobado contra la API real: la raíz no trae ningún campo `Status`.
 *
 * Una misma ficha puede estar en varias unidades de negocio (Falabella,
 * Sodimac, Tottus) con precio y stock distintos en cada una.
 */
export interface FalabellaBusinessUnit {
    BusinessUnit?: string;
    OperatorCode?: string;
    Price?: string | number;
    SpecialPrice?: string | number;
    SpecialFromDate?: string;
    SpecialToDate?: string;
    Stock?: string | number;
    /** active | inactive | deleted */
    Status?: string;
    /** '1' cuando la ficha está visible en la tienda. */
    IsPublished?: string | number;
    AvailableToSell?: { Site?: { Site?: string | string[] } };
}

export interface FalabellaProduct {
    /** SKU del vendedor: es el que casa con nuestro catálogo. */
    SellerSku: string;
    /** SKU que Falabella asigna en su tienda. */
    ShopSku?: string;
    ProductId?: string;
    Name?: string;
    Description?: string;
    Brand?: string;
    Variation?: string;
    ParentSku?: string;
    /** Dirección pública de la ficha. */
    Url?: string;
    MainImage?: string;
    Images?: { Image?: string | string[] };
    /**
     * Nota de 0 a 100 que Falabella pone a la calidad de la ficha. Es la
     * medida de optimización que hasta ahora se calculaba a mano en una hoja.
     */
    ContentScore?: string | number;
    /** Resultado del control de calidad: approved, pending, rejected. */
    QCStatus?: string;
    PrimaryCategory?: string;
    PrimaryCategoryId?: string | number;
    BusinessUnits?: { BusinessUnit?: FalabellaBusinessUnit | FalabellaBusinessUnit[] };
    ProductData?: Record<string, any>;
}

/**
 * Devuelve la unidad de negocio principal de una ficha.
 * Falabella manda un objeto cuando hay una sola y un array cuando hay varias;
 * sin normalizarlo, la mitad de los catálogos se leerían como vacíos.
 */
export function unidadPrincipal(producto: FalabellaProduct): FalabellaBusinessUnit {
    const unidad = producto?.BusinessUnits?.BusinessUnit;
    if (!unidad) return {};
    const lista = Array.isArray(unidad) ? unidad : [unidad];
    // Se prefiere la que esté publicada; si ninguna lo está, la primera.
    return lista.find(u => String(u?.IsPublished ?? '') === '1') ?? lista[0] ?? {};
}

/** Sitios donde la ficha aparece publicada (Falabella, Sodimac, Tottus...). */
export function sitiosPublicados(unidad: FalabellaBusinessUnit): string[] {
    const sitios = unidad?.AvailableToSell?.Site?.Site;
    if (!sitios) return [];
    return (Array.isArray(sitios) ? sitios : [sitios]).map(s => String(s));
}

export interface FalabellaWebhook {
    WebhookId: string;
    CallbackUrl: string;
    WebhookSource?: string;
    Events?: { Event: string[] | string };
}

export interface FalabellaOrder {
    OrderId: number;
    OrderNumber: number;
    CustomerFirstName?: string;
    CustomerLastName?: string;
    Price?: string;
    CreatedAt?: string;
    UpdatedAt?: string;
    ItemsCount?: number;
    Statuses?: string[];
    PaymentMethod?: string;
}

const API_BASE = 'https://sellercenter-api.falabella.com';
const API_VERSION = '1.0';
const ATTRIBUTE_CACHE_MS = 60 * 60 * 1000; // 1 hora
// El árbol pesa ~0,4 MB y tarda unos 6 segundos: no se pide en cada búsqueda.
const CATEGORY_CACHE_MS = 12 * 60 * 60 * 1000; // 12 horas

/**
 * Cliente HTTP del Seller Center de Falabella.
 *
 * A diferencia de Mercado Libre y Yavendió, aquí no hay cabecera de
 * autenticación: la identidad viaja dentro de la propia URL, firmada. Toda la
 * mecánica de la firma vive en falabella-signature.ts; esta clase solo arma
 * las llamadas y traduce las respuestas.
 *
 * Ojo con los límites: las cinco acciones que generan feeds (ProductCreate,
 * ProductUpdate, ProductRemove, Image, UpdateStock) admiten 50 llamadas
 * seguidas y a partir de ahí exigen 2 minutos entre una y otra. Por eso
 * Falabella pide mandar los productos en lotes de 500 a 1000, y no de uno en
 * uno como se hace con Mercado Libre.
 *
 * Docs: https://developers.falabella.com
 */
@Injectable()
export class FalabellaApiService {
    private readonly logger = new Logger('FalabellaApi');
    private readonly http: AxiosInstance;
    /** Atributos por categoría; evita repetir la misma consulta en cada lote. */
    private readonly attributeCache = new Map<string, { at: number; attributes: FalabellaAttribute[] }>();
    /** Categorías finales ya aplanadas, con su ruta. */
    private readonly categoryCache = new Map<string, { at: number; categories: FalabellaCategory[] }>();

    constructor() {
        this.http = axios.create({ baseURL: API_BASE, timeout: 30000 });
    }

    /**
     * Traduce los errores a algo que un no técnico entienda. Falabella
     * responde con códigos (E014, E017...) y mensajes en inglés dentro de un
     * ErrorResponse, no con códigos HTTP distintos.
     */
    private describeError(action: string, code?: string, message?: string): Error {
        const detalle = [code, message].filter(Boolean).join(' ');

        // La firma inválida es EL error de esta integración: si las
        // credenciales están mal, absolutamente todo falla igual.
        if (/signature|authenticat|api key|user/i.test(message || '')) {
            return new BadRequestException(
                'Falabella rechazó las credenciales: revisa que el UserID sea el correo exacto de tu cuenta ' +
                `de Seller Center y que la API key esté completa y vigente. (${detalle})`,
            );
        }
        return new ServiceUnavailableException(`Falabella rechazó la petición ${action}: ${detalle || 'error desconocido'}`);
    }

    /**
     * Ejecuta una acción de consulta y devuelve el cuerpo de la respuesta.
     * Se pide siempre en JSON: el formato por defecto de la API es XML.
     */
    async call<T = any>(
        credentials: FalabellaCredentials,
        action: string,
        extraParams: Record<string, string | number> = {},
    ): Promise<T> {
        const params: Record<string, string | number> = {
            Action: action,
            Format: 'JSON',
            Timestamp: falabellaTimestamp(),
            UserID: credentials.userId,
            Version: API_VERSION,
            ...extraParams,
        };

        const query = buildSignedQuery(params, credentials.apiKey);

        let data: any;
        try {
            const response = await this.http.get(`/?${query}`);
            data = response.data;
        } catch (error) {
            const axiosError = error as AxiosError<any>;
            const cuerpo = axiosError?.response?.data;
            const head = cuerpo?.ErrorResponse?.Head;
            if (head) {
                throw this.describeError(action, head.ErrorCode, head.ErrorMessage);
            }
            throw new ServiceUnavailableException(
                `No se pudo contactar con Falabella (${action}): ${axiosError?.message || 'error de red'}`,
            );
        }

        // Falabella devuelve 200 incluso cuando la petición falló: el fallo
        // viene dentro del cuerpo, así que hay que mirarlo siempre.
        if (data?.ErrorResponse) {
            const head = data.ErrorResponse.Head || {};
            throw this.describeError(action, head.ErrorCode, head.ErrorMessage);
        }

        return data?.SuccessResponse?.Body as T;
    }

    /**
     * Marcas del catálogo de Falabella.
     *
     * CUIDADO: comprobado contra la API real, GetBrands NO valida la firma —
     * responde el catálogo completo aunque la API key sea inventada. Es un
     * catálogo global, no datos del vendedor. NO sirve para comprobar
     * credenciales; para eso está verifyCredentials.
     */
    async getBrands(credentials: FalabellaCredentials): Promise<FalabellaBrand[]> {
        const body = await this.call<any>(credentials, 'GetBrands');
        const brands = body?.Brands?.Brand ?? [];
        return Array.isArray(brands) ? brands : [brands];
    }

    /**
     * Comprueba que las credenciales sirven de verdad.
     *
     * Usa GetProducts porque consulta datos del propio vendedor y sí verifica
     * la firma: con una clave incorrecta responde «E007: Login failed.
     * Signature mismatch». Se pide un solo producto para que la llamada sea
     * barata, y no es ninguna de las cinco acciones con límite estricto.
     */
    async verifyCredentials(credentials: FalabellaCredentials): Promise<void> {
        await this.call(credentials, 'GetProducts', { Limit: 1, Offset: 0 });
    }

    /**
     * Extrae el identificador del feed de la respuesta.
     *
     * ProductCreate puede responder en JSON o en XML según le convenga a la
     * API, así que se contemplan los dos: sin este identificador no hay forma
     * de saber después si los productos entraron.
     */
    private extractFeedId(data: any): string {
        if (typeof data === 'string') {
            const match = data.match(/<RequestId>([^<]+)<\/RequestId>/);
            if (match) return match[1];
        }
        const id = data?.SuccessResponse?.Head?.RequestId;
        if (!id) {
            throw new ServiceUnavailableException(
                'Falabella aceptó el envío pero no devolvió el identificador del lote, así que no se puede seguir su estado.',
            );
        }
        return id;
    }

    /**
     * Envía un lote de productos. Devuelve el identificador del feed.
     *
     * IMPORTANTE: responder 200 solo significa que Falabella recibió el lote,
     * NO que los productos se hayan creado. El resultado real se consulta
     * después con getFeedStatus.
     */
    async productCreate(
        credentials: FalabellaCredentials,
        products: FalabellaProductInput[],
        operatorCode: string,
    ): Promise<string> {
        if (products.length === 0) {
            throw new BadRequestException('No hay productos que enviar a Falabella.');
        }

        const xml = buildProductFeedXml(products, { operatorCode });
        const feedId = await this.postFeed(credentials, 'ProductCreate', xml);
        this.logger.log(`Lote de ${products.length} productos enviado a Falabella. Feed ${feedId}.`);
        return feedId;
    }

    /**
     * Da de baja productos por su SKU. Genera un feed igual que el alta, así
     * que también se procesa en diferido y cuenta para el límite de llamadas.
     */
    async productRemove(credentials: FalabellaCredentials, sellerSkus: string[]): Promise<string> {
        if (!sellerSkus.length) {
            throw new BadRequestException('No hay productos que dar de baja en Falabella.');
        }
        const cuerpo = sellerSkus
            .map(sku => `<Product><SellerSku>${escapeXml(sku)}</SellerSku></Product>`)
            .join('');
        const xml = `<?xml version="1.0" encoding="UTF-8"?><Request>${cuerpo}</Request>`;

        const feedId = await this.postFeed(credentials, 'ProductRemove', xml);
        this.logger.warn(`Baja de ${sellerSkus.length} productos en Falabella. Feed ${feedId}.`);
        return feedId;
    }

    /**
     * Envía un XML a una acción de feed y devuelve el identificador del lote.
     * La firma cubre solo los parámetros de la URL; el XML viaja en el cuerpo.
     */
    private async postFeed(
        credentials: FalabellaCredentials,
        action: string,
        xml: string,
    ): Promise<string> {
        return this.extractFeedId(await this.postFeedRaw(credentials, action, xml));
    }

    /** Envía un XML y devuelve la respuesta completa. */
    private async postFeedRaw(
        credentials: FalabellaCredentials,
        action: string,
        xml: string,
    ): Promise<any> {
        const params: Record<string, string | number> = {
            Action: action,
            Format: 'JSON',
            Timestamp: falabellaTimestamp(),
            UserID: credentials.userId,
            Version: API_VERSION,
        };
        const query = buildSignedQuery(params, credentials.apiKey);

        let data: any;
        try {
            const response = await this.http.post(`/?${query}`, xml, {
                headers: { 'Content-Type': 'text/xml; charset=UTF-8' },
            });
            data = response.data;
        } catch (error) {
            const axiosError = error as AxiosError<any>;
            const head = axiosError?.response?.data?.ErrorResponse?.Head;
            if (head) throw this.describeError(action, head.ErrorCode, head.ErrorMessage);
            throw new ServiceUnavailableException(
                `No se pudo enviar el lote a Falabella (${action}): ${axiosError?.message || 'error de red'}`,
            );
        }

        if (data?.ErrorResponse) {
            const head = data.ErrorResponse.Head || {};
            throw this.describeError(action, head.ErrorCode, head.ErrorMessage);
        }

        return data;
    }

    /**
     * Estado de un lote enviado: cuántos entraron, cuántos fallaron y por qué.
     * Falabella agrupa los errores por SKU.
     */
    async getFeedStatus(credentials: FalabellaCredentials, feedId: string): Promise<FalabellaFeedStatus> {
        const body = await this.call<any>(credentials, 'FeedStatus', { FeedID: feedId });
        const feed = body?.FeedDetail ?? body?.Feed ?? body ?? {};

        // Los errores llegan anidados y a veces como objeto suelto en vez de lista.
        const rawErrors = feed?.FeedErrors?.Error ?? [];
        const errors = (Array.isArray(rawErrors) ? rawErrors : [rawErrors])
            .filter(Boolean)
            .map((e: any) => ({
                sku: e?.SellerSku ?? e?.SellerSKU ?? undefined,
                message: [e?.Code, e?.Message].filter(Boolean).join(': ') || 'error sin detalle',
            }));

        return {
            feedId: feed?.Feed ?? feedId,
            status: feed?.Status ?? 'unknown',
            action: feed?.Action ?? '',
            totalRecords: Number(feed?.TotalRecords ?? 0),
            processedRecords: Number(feed?.ProcessedRecords ?? 0),
            failedRecords: Number(feed?.FailedRecords ?? 0),
            errors,
        };
    }

    /**
     * Atributos que pide una categoría, con cuáles son obligatorios y qué
     * valores admiten.
     *
     * Cada categoría exige cosas distintas: la de accesorios de automoción
     * pide `tipo_automotriz`, la de mascarillas pide otras. Sin consultarlo
     * primero, publicar es adivinar — y Falabella solo avisa del error
     * después de procesar el lote entero.
     *
     * Se guarda en memoria un rato porque no cambia de un minuto a otro y
     * cada consulta gasta una llamada.
     */
    async getCategoryAttributes(
        credentials: FalabellaCredentials,
        categoryId: number | string,
    ): Promise<FalabellaAttribute[]> {
        const clave = `${credentials.userId}:${categoryId}`;
        const enCache = this.attributeCache.get(clave);
        if (enCache && Date.now() - enCache.at < ATTRIBUTE_CACHE_MS) {
            return enCache.attributes;
        }

        const body = await this.call<any>(credentials, 'GetCategoryAttributes', { PrimaryCategory: categoryId });
        const crudos = [].concat(body?.Attribute ?? body?.Attributes?.Attribute ?? []).filter(Boolean) as any[];

        // Falabella manda los dos nombres: `Name` en minúsculas para
        // identificar el atributo y `FeedName` tal cual debe ir en el XML.
        const attributes: FalabellaAttribute[] = crudos.map(a => ({
            name: a.Name ?? a.FeedName,
            feedName: a.FeedName ?? a.Name,
            label: a.Label ?? a.Name ?? '',
            isMandatory: String(a.isMandatory ?? a.IsMandatory ?? '0') === '1',
            inputType: a.InputType ?? '',
            options: [].concat(a.Options?.Option ?? [])
                .filter(Boolean)
                .map((o: any) => o?.Name ?? o?.GlobalIdentifier)
                .filter(Boolean),
        }));

        this.attributeCache.set(clave, { at: Date.now(), attributes });
        return attributes;
    }

    /**
     * Todas las categorías donde se puede publicar, aplanadas.
     *
     * Solo se devuelven las categorías finales: Falabella no admite publicar
     * en una intermedia. Cada una lleva su ruta completa porque hay nombres
     * que se repiten y sin el camino no se distinguen.
     */
    async getCategories(credentials: FalabellaCredentials): Promise<FalabellaCategory[]> {
        const enCache = this.categoryCache.get(credentials.userId);
        if (enCache && Date.now() - enCache.at < CATEGORY_CACHE_MS) {
            return enCache.categories;
        }

        const body = await this.call<any>(credentials, 'GetCategoryTree');
        const categories: FalabellaCategory[] = [];

        const recorrer = (nodos: any, ruta: string[]) => {
            for (const nodo of [].concat(nodos ?? []).filter(Boolean) as any[]) {
                const camino = [...ruta, nodo.Name];
                const hijos = [].concat(nodo.Children?.Category ?? []).filter(Boolean);
                if (hijos.length) {
                    recorrer(hijos, camino);
                } else {
                    categories.push({
                        id: String(nodo.CategoryId),
                        name: nodo.Name,
                        path: camino.join(' › '),
                    });
                }
            }
        };
        recorrer(body?.Categories?.Category, []);

        this.categoryCache.set(credentials.userId, { at: Date.now(), categories });
        this.logger.log(`Árbol de categorías de Falabella cargado: ${categories.length} categorías finales.`);
        return categories;
    }

    /**
     * Quita tildes y pasa a minúsculas para comparar.
     * Sin esto, buscar "audifonos" no encuentra "Audífonos", y nadie escribe
     * con tildes cuando busca.
     */
    private normalizar(texto: string): string {
        return texto
            .normalize('NFD')
            .replace(/\p{Diacritic}/gu, '') // quita las marcas de acento
            .toLowerCase();
    }

    /** Busca categorías por nombre o por ruta, sin distinguir tildes. */
    async searchCategories(
        credentials: FalabellaCredentials,
        term: string,
        limit = 30,
    ): Promise<FalabellaCategory[]> {
        const categories = await this.getCategories(credentials);
        const buscado = this.normalizar((term || '').trim());
        if (!buscado) return categories.slice(0, limit);

        // Primero las que empiezan por el término: suelen ser la que se busca.
        const empiezan: FalabellaCategory[] = [];
        const contienen: FalabellaCategory[] = [];
        for (const category of categories) {
            const nombre = this.normalizar(category.name);
            if (nombre.startsWith(buscado)) empiezan.push(category);
            else if (nombre.includes(buscado) || this.normalizar(category.path).includes(buscado)) contienen.push(category);
        }
        return [...empiezan, ...contienen].slice(0, limit);
    }

    /**
     * Ítems de un pedido. Falabella no los incluye en GetOrders: hay que
     * pedirlos aparte, y son los que dicen qué SKU se vendió.
     */
    async getOrderItems(credentials: FalabellaCredentials, orderId: string | number): Promise<FalabellaOrderItem[]> {
        const body = await this.call<any>(credentials, 'GetOrderItems', { OrderId: orderId });
        const items = body?.OrderItems?.OrderItem ?? [];
        return (Array.isArray(items) ? items : [items]).filter(Boolean);
    }

    /** Webhooks registrados en la cuenta. */
    async getWebhooks(credentials: FalabellaCredentials): Promise<FalabellaWebhook[]> {
        const body = await this.call<any>(credentials, 'GetWebhooks');
        const hooks = body?.Webhooks?.Webhook ?? [];
        return (Array.isArray(hooks) ? hooks : [hooks]).filter(Boolean);
    }

    /**
     * Registra un webhook.
     *
     * IMPORTANTE: se AÑADE, no se reemplaza. Una cuenta puede tener otros
     * webhooks de otras plataformas —la de este vendedor apunta a Yuju— y
     * borrarlos dejaría al cliente sin recibir sus ventas allí.
     */
    async createWebhook(
        credentials: FalabellaCredentials,
        callbackUrl: string,
        events: string[],
    ): Promise<string> {
        const eventos = events.map(e => `<Event>${escapeXml(e)}</Event>`).join('');
        const xml =
            `<?xml version="1.0" encoding="UTF-8"?>` +
            `<Request><Webhook>` +
            `<CallbackUrl>${escapeXml(callbackUrl)}</CallbackUrl>` +
            `<Events>${eventos}</Events>` +
            `</Webhook></Request>`;

        const data = await this.postFeedRaw(credentials, 'CreateWebhook', xml);
        const id = data?.SuccessResponse?.Body?.Webhook?.WebhookId
            ?? data?.SuccessResponse?.Head?.RequestId;
        this.logger.log(`Webhook creado en Falabella: ${id} → ${callbackUrl}`);
        return String(id ?? '');
    }

    /** Elimina un webhook por su id. Solo se usa sobre los nuestros. */
    async deleteWebhook(credentials: FalabellaCredentials, webhookId: string): Promise<void> {
        const xml =
            `<?xml version="1.0" encoding="UTF-8"?>` +
            `<Request><Webhook><WebhookId>${escapeXml(webhookId)}</WebhookId></Webhook></Request>`;
        await this.postFeedRaw(credentials, 'DeleteWebhook', xml);
        this.logger.warn(`Webhook eliminado en Falabella: ${webhookId}`);
    }

    /** Pedidos del vendedor, opcionalmente desde una fecha. */
    async getOrders(
        credentials: FalabellaCredentials,
        options: { createdAfter?: Date; limit?: number; offset?: number } = {},
    ): Promise<FalabellaOrder[]> {
        const extra: Record<string, string | number> = {
            Limit: options.limit ?? 100,
            Offset: options.offset ?? 0,
        };
        if (options.createdAfter) {
            extra.CreatedAfter = falabellaTimestamp(options.createdAfter);
        }

        const body = await this.call<any>(credentials, 'GetOrders', extra);
        const orders = body?.Orders?.Order ?? [];
        return Array.isArray(orders) ? orders : [orders];
    }

    /**
     * Una página del catálogo del vendedor.
     *
     * `filter` acepta los valores de Falabella: all, live, inactive, deleted,
     * pending, rejected, sold-out, imageMissing. Se usa 'all' por defecto
     * porque para el tablero interesan también las fichas rechazadas o sin
     * imagen: son justamente las que hay que arreglar.
     */
    async getProducts(
        credentials: FalabellaCredentials,
        options: { limit?: number; offset?: number; filter?: string } = {},
    ): Promise<FalabellaProduct[]> {
        const body = await this.call<any>(credentials, 'GetProducts', {
            Limit: options.limit ?? PRODUCTOS_POR_PAGINA,
            Offset: options.offset ?? 0,
            Filter: options.filter ?? 'all',
        });
        const products = body?.Products?.Product ?? [];
        return Array.isArray(products) ? products : [products];
    }

    /**
     * Todo el catálogo del vendedor, pasando página a página.
     *
     * Falabella limita a 50 llamadas seguidas y luego obliga a espaciarlas dos
     * minutos, así que entre página y página se deja un respiro y hay un tope
     * de seguridad: es preferible avisar de que un catálogo es enorme antes que
     * quedarse colgado o que nos corten el acceso a media importación.
     */
    async getAllProducts(
        credentials: FalabellaCredentials,
        options: { filter?: string; maxProductos?: number } = {},
    ): Promise<{ productos: FalabellaProduct[]; incompleto: boolean }> {
        const tope = options.maxProductos ?? MAX_PRODUCTOS;
        const productos: FalabellaProduct[] = [];
        const vistos = new Set<string>();
        let offset = 0;
        let incompleto = false;

        for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
            const lote = await this.getProducts(credentials, {
                limit: PRODUCTOS_POR_PAGINA,
                offset,
                filter: options.filter,
            });

            for (const producto of lote) {
                const sku = String(producto?.SellerSku ?? '').trim();
                // Falabella puede repetir una ficha entre páginas si el
                // catálogo cambia mientras se recorre; sin esto se contarían
                // dos veces y el informe saldría inflado.
                if (!sku || vistos.has(sku)) continue;
                vistos.add(sku);
                productos.push(producto);
            }

            if (lote.length < PRODUCTOS_POR_PAGINA) break;
            if (productos.length >= tope) { incompleto = true; break; }

            offset += PRODUCTOS_POR_PAGINA;
            await new Promise(r => setTimeout(r, PAUSA_ENTRE_PAGINAS_MS));
        }

        this.logger.log(
            `Catálogo de Falabella leído: ${productos.length} publicaciones` +
            (incompleto ? ' (se alcanzó el tope, faltan más)' : ''),
        );
        return { productos, incompleto };
    }
}
