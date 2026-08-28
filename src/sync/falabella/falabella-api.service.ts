import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { buildSignedQuery, falabellaTimestamp } from './falabella-signature';

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
     * Marcas del catálogo. Es la consulta más barata y sin filtros de la API,
     * así que se usa para comprobar unas credenciales recién pegadas: si
     * responde, la firma y la clave son correctas.
     */
    async getBrands(credentials: FalabellaCredentials): Promise<FalabellaBrand[]> {
        const body = await this.call<any>(credentials, 'GetBrands');
        const brands = body?.Brands?.Brand ?? [];
        return Array.isArray(brands) ? brands : [brands];
    }

    /** Comprueba que las credenciales sirven. Devuelve cuántas marcas ve la cuenta. */
    async verifyCredentials(credentials: FalabellaCredentials): Promise<{ brandCount: number }> {
        const brands = await this.getBrands(credentials);
        return { brandCount: brands.length };
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
