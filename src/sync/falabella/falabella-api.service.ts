import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { buildSignedQuery, falabellaTimestamp } from './falabella-signature';
import { buildProductFeedXml, escapeXml, FalabellaProductInput } from './falabella-product-xml';

/** Lo que hace falta para hablar con la cuenta de un vendedor. */
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

        return this.extractFeedId(data);
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
}
