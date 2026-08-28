import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import axios, { AxiosInstance, AxiosError } from 'axios';

export interface YavendioCompany {
    id: string;
    name: string;
    phoneNumber?: string | null;
    country?: string | null;
    currency?: string | null;
    planName?: string | null;
}

export interface YavendioConversation {
    id: string;
    customer: { name?: string | null; phone_number?: string | null };
    contact_id?: string | null;
    last_message_preview?: string | null;
    last_message_direction?: 'inbound' | 'outbound' | null;
    unread_count?: number;
    paused?: boolean;
    sale_status?: 'positive' | 'negative' | null;
    tags?: { id: number; name: string }[];
    created_at?: string | null;
    updated_at?: string | null;
}

export interface YavendioOrder {
    id: number;
    order_date: string;
    status?: string | null;
    payment_method?: string;
    currency?: string;
    total_amount?: string;
    customer: { name: string; phone_number?: string | null };
    items?: { sku?: string | null; name: string; quantity: number; base_price: string }[];
    summary_conversation?: string | null;
}

interface Page<T> {
    data: T[];
    pagination?: { page: number; limit: number; has_more?: boolean; total_items?: number; total_pages?: number };
}

/** Tope de páginas por barrido: evita que una cuenta enorme cuelgue la importación. */
const MAX_PAGES = 40;
const PAGE_SIZE = 100; // el máximo que admite la API
/** Páginas pedidas a la vez: suficiente para acelerar sin provocar un 429. */
const CONCURRENCY = 5;

/**
 * Cliente HTTP de la API de negocio de Yavendió.
 * Solo habla HTTP; las decisiones viven en los servicios que lo usan.
 *
 * Docs: https://docs.ya.works — base https://api.ya.onl/v1,
 * autenticación por cabecera X-API-Key (claves con formato yv_live_v1_...).
 */
@Injectable()
export class YavendioApiService {
    private readonly logger = new Logger('YavendioApi');
    private readonly http: AxiosInstance;

    constructor() {
        this.http = axios.create({ baseURL: 'https://api.ya.onl/v1', timeout: 20000 });
    }

    private headers(apiKey: string) {
        return { 'X-API-Key': apiKey };
    }

    /**
     * Traduce los errores de la API a mensajes que un no técnico entienda.
     * Sin esto el usuario ve "Request failed with status code 401" y no sabe
     * si escribió mal la clave o si el servicio está caído.
     */
    private describeError(error: unknown, action: string): Error {
        const axiosError = error as AxiosError<any>;
        const status = axiosError?.response?.status;

        if (status === 401) {
            return new BadRequestException(
                'Yavendió rechazó la clave: es inválida o fue revocada. Genera una nueva en tu panel de Yavendió (Configuración → Claves API) y vuelve a conectar.',
            );
        }
        if (status === 403) {
            return new BadRequestException(
                'La clave de Yavendió no tiene permisos suficientes para esta operación. Crea una con acceso completo.',
            );
        }
        if (status === 429) {
            return new ServiceUnavailableException(
                'Yavendió está limitando las peticiones por exceso de uso. Espera un momento y vuelve a intentarlo.',
            );
        }

        const detail = axiosError?.response?.data?.message || axiosError?.message || 'error desconocido';
        return new ServiceUnavailableException(`No se pudo ${action} en Yavendió: ${detail}`);
    }

    /**
     * Cuando la API responde 429 indica en Retry-After cuántos segundos
     * esperar. Reintentamos una vez respetando ese margen; si vuelve a
     * fallar, el error sube y la importación se detiene con un mensaje claro.
     */
    private async get<T>(apiKey: string, path: string, params: Record<string, any>, action: string): Promise<T> {
        try {
            const { data } = await this.http.get<T>(path, { params, headers: this.headers(apiKey) });
            return data;
        } catch (error) {
            const axiosError = error as AxiosError;
            if (axiosError?.response?.status === 429) {
                const retryAfter = Number(axiosError.response.headers?.['retry-after']) || 2;
                const waitMs = Math.min(retryAfter, 30) * 1000;
                this.logger.warn(`Límite de peticiones alcanzado; reintentando en ${waitMs / 1000}s.`);
                await new Promise(resolve => setTimeout(resolve, waitMs));
                try {
                    const { data } = await this.http.get<T>(path, { params, headers: this.headers(apiKey) });
                    return data;
                } catch (retryError) {
                    throw this.describeError(retryError, action);
                }
            }
            throw this.describeError(error, action);
        }
    }

    /**
     * Recorre todas las páginas de un recurso paginado.
     *
     * La primera página nos dice cuántas hay en total, así que el resto se
     * piden en tandas paralelas en vez de una detrás de otra: con ~1.500
     * conversaciones eso baja la espera de unos 20 segundos a unos pocos.
     * La tanda se mantiene pequeña para no gatillar el límite de peticiones.
     */
    private async getAllPages<T>(apiKey: string, path: string, action: string, extraParams: Record<string, any> = {}): Promise<T[]> {
        const fetchPage = (page: number) =>
            this.get<Page<T>>(apiKey, path, { page, limit: PAGE_SIZE, ...extraParams }, action);

        const first = await fetchPage(1);
        const all: T[] = [...(first?.data || [])];

        const totalPages = first?.pagination?.total_pages;
        if (!totalPages || totalPages <= 1) {
            // Sin total_pages fiable, se sigue de a una hasta que se acabe.
            if (first?.pagination?.has_more && (first?.data?.length || 0) >= PAGE_SIZE) {
                for (let page = 2; page <= MAX_PAGES; page++) {
                    const body = await fetchPage(page);
                    const rows = body?.data || [];
                    all.push(...rows);
                    if (body?.pagination?.has_more === false || rows.length < PAGE_SIZE) break;
                }
            }
            return all;
        }

        const lastPage = Math.min(totalPages, MAX_PAGES);
        if (totalPages > MAX_PAGES) {
            this.logger.warn(`${action}: la cuenta tiene ${totalPages} páginas y el tope es ${MAX_PAGES}; quedarán datos sin traer.`);
        }

        for (let page = 2; page <= lastPage; page += CONCURRENCY) {
            const tanda: Promise<Page<T>>[] = [];
            for (let i = page; i < page + CONCURRENCY && i <= lastPage; i++) {
                tanda.push(fetchPage(i));
            }
            const bodies = await Promise.all(tanda);
            bodies.forEach(body => all.push(...(body?.data || [])));
        }

        return all;
    }

    /**
     * Perfil de la empresa. Es la llamada más barata de la API, así que la
     * usamos para validar una clave recién pegada y saber a qué cuenta
     * pertenece — el equivalente al nickname en Mercado Libre.
     */
    async getCompany(apiKey: string): Promise<YavendioCompany> {
        const data = await this.get<any>(apiKey, '/company', {}, 'leer el perfil de la empresa');
        if (!data?.id) {
            throw new BadRequestException('Yavendió respondió sin identificar la empresa. Revisa la clave.');
        }
        return {
            id: String(data.id),
            name: data.name,
            phoneNumber: data.phone_number ?? null,
            country: data.country ?? null,
            currency: data.currency ?? null,
            planName: data.plan_display_name ?? data.plan_name ?? null,
        };
    }

    async listConversations(apiKey: string): Promise<YavendioConversation[]> {
        return this.getAllPages<YavendioConversation>(apiKey, '/conversations', 'leer las conversaciones');
    }

    async listOrders(apiKey: string): Promise<YavendioOrder[]> {
        return this.getAllPages<YavendioOrder>(apiKey, '/orders', 'leer los pedidos');
    }

    async listContacts(apiKey: string): Promise<any[]> {
        return this.getAllPages<any>(apiKey, '/contacts', 'leer los contactos');
    }
}
