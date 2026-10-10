import { Injectable, InternalServerErrorException } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

export interface MeliTokens {
    accessToken: string;
    refreshToken: string;
    expiresIn: number; // seconds
    externalUserId: string;
}

// The modern ML items API takes family_name (+ attributes to build the
// title server-side) and REJECTS an explicit title field.
export interface MeliItemPayload {
    family_name: string;
    category_id: string;
    price: number;
    currency_id: string;
    available_quantity: number;
    condition: 'new' | 'used';
    listing_type_id: string;
    pictures: { source: string }[];
    attributes: { id: string; value_name: string }[];
}

/**
 * Thin HTTP client over the Mercado Libre REST API.
 * Only speaks HTTP — all business logic lives in SyncService.
 * Docs: https://developers.mercadolibre.com
 */
@Injectable()
export class MeliApiService {
    private readonly http: AxiosInstance;
    private readonly authBase = 'https://auth.mercadolibre.com.pe'; // site-specific auth domain
    private readonly apiBase = 'https://api.mercadolibre.com';

    constructor() {
        this.http = axios.create({ baseURL: this.apiBase, timeout: 15000 });
        // Mercado Libre explica el rechazo en el cuerpo; sin esto solo se vería «status code 403».
        this.http.interceptors.response.use(undefined, (error: any) => {
            const d = error?.response?.data;
            const motivo = [d?.message, d?.error].filter((x: any) => typeof x === 'string' && x).join(' · ');
            if (error?.response?.status && motivo) {
                error.message = `Mercado Libre respondió ${error.response.status} (${error.config?.url ?? ''}): ${motivo}`;
            }
            return Promise.reject(error);
        });
    }

    private get clientId(): string {
        return process.env.MELI_CLIENT_ID || '';
    }

    private get clientSecret(): string {
        return process.env.MELI_CLIENT_SECRET || '';
    }

    private get redirectUri(): string {
        return process.env.MELI_REDIRECT_URI || '';
    }

    assertConfigured(): void {
        if (!this.clientId || !this.clientSecret || !this.redirectUri) {
            throw new InternalServerErrorException(
                'La integración con Mercado Libre no está configurada. Define MELI_CLIENT_ID, MELI_CLIENT_SECRET y MELI_REDIRECT_URI en el .env.',
            );
        }
    }

    /** URL where the seller authorizes the Synkro app (OAuth authorization code flow). */
    buildAuthUrl(state: string): string {
        this.assertConfigured();
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: this.clientId,
            redirect_uri: this.redirectUri,
            state,
        });
        return `${this.authBase}/authorization?${params.toString()}`;
    }

    /** Exchanges the authorization code for access/refresh tokens. */
    async exchangeCode(code: string): Promise<MeliTokens> {
        this.assertConfigured();
        const { data } = await this.http.post('/oauth/token', {
            grant_type: 'authorization_code',
            client_id: this.clientId,
            client_secret: this.clientSecret,
            code,
            redirect_uri: this.redirectUri,
        });
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresIn: data.expires_in,
            externalUserId: String(data.user_id),
        };
    }

    /** Refreshes an expired access token (Mercado Libre tokens last 6 hours). */
    async refreshTokens(refreshToken: string): Promise<MeliTokens> {
        this.assertConfigured();
        const { data } = await this.http.post('/oauth/token', {
            grant_type: 'refresh_token',
            client_id: this.clientId,
            client_secret: this.clientSecret,
            refresh_token: refreshToken,
        });
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresIn: data.expires_in,
            externalUserId: String(data.user_id),
        };
    }

    /** Basic profile of the authorized seller. */
    async getMe(accessToken: string): Promise<{ id: string; nickname: string }> {
        const { data } = await this.http.get('/users/me', {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        return { id: String(data.id), nickname: data.nickname };
    }

    /** Publishes a new item. Returns the Mercado Libre item id (e.g. 'MPE123...') and permalink. */
    async createItem(accessToken: string, payload: MeliItemPayload): Promise<{ id: string; permalink: string }> {
        const { data } = await this.http.post('/items', payload, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        return { id: data.id, permalink: data.permalink };
    }

    /** Sets the plain-text description of an item (separate endpoint in the ML API). */
    async setItemDescription(accessToken: string, itemId: string, plainText: string): Promise<void> {
        await this.http.post(
            `/items/${itemId}/description`,
            { plain_text: plainText },
            { headers: { Authorization: `Bearer ${accessToken}` } },
        );
    }

    /** Pushes stock and/or price changes to an existing item. */
    async updateItem(
        accessToken: string,
        itemId: string,
        changes: {
            available_quantity?: number;
            price?: number;
            /** Para publicaciones con variantes: stock y precio van por variante, no por publicación. */
            variations?: { id: string | number; available_quantity?: number; price?: number }[];
        },
    ): Promise<void> {
        await this.http.put(`/items/${itemId}`, changes, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
    }

    /** Pauses/reactivates a listing. */
    async setItemStatus(accessToken: string, itemId: string, status: 'paused' | 'active'): Promise<void> {
        await this.http.put(
            `/items/${itemId}`,
            { status },
            { headers: { Authorization: `Bearer ${accessToken}` } },
        );
    }

    /**
     * Predicts the best real category for a title using Mercado Libre's
     * official domain discovery API. Used as fallback when the product
     * has no category id (or a demo/foreign one) at publish time.
     */
    async predictCategory(accessToken: string, title: string): Promise<string | undefined> {
        const site = process.env.MELI_SITE_ID || 'MPE';
        const { data } = await this.http.get(
            `/sites/${site}/domain_discovery/search`,
            {
                params: { q: title, limit: 1 },
                headers: { Authorization: `Bearer ${accessToken}` },
            },
        );
        return data?.[0]?.category_id;
    }

    /** Fetches an order (used when processing sale notifications). */
    /**
     * Ids de TODAS las publicaciones de un vendedor. Usa el modo «scan» de ML,
     * que no tiene el tope de 1.000 resultados de la paginación normal.
     */
    async listSellerItemIds(accessToken: string, sellerId: string, max = 5000): Promise<{ ids: string[]; incompleto: boolean }> {
        const ids: string[] = [];
        let scrollId: string | undefined;
        for (let i = 0; i < 100 && ids.length < max; i++) {
            const { data } = await this.http.get(`/users/${sellerId}/items/search`, {
                headers: { Authorization: `Bearer ${accessToken}` },
                params: { search_type: 'scan', limit: 100, ...(scrollId ? { scroll_id: scrollId } : {}) },
            });
            const lote: string[] = Array.isArray(data?.results) ? data.results : [];
            if (!lote.length) return { ids, incompleto: false };
            ids.push(...lote);
            scrollId = data?.scroll_id ?? scrollId;
            if (!scrollId) break;
        }
        return { ids: ids.slice(0, max), incompleto: ids.length >= max };
    }

    /** Datos de varias publicaciones (ML admite hasta 20 por llamada). */
    async getItems(accessToken: string, ids: string[]): Promise<{ items: any[]; notFound: string[] }> {
        const items: any[] = [];
        const notFound: string[] = [];
        for (let i = 0; i < ids.length; i += 20) {
            const { data } = await this.http.get('/items', {
                headers: { Authorization: `Bearer ${accessToken}` },
                params: { ids: ids.slice(i, i + 20).join(',') },
            });
            for (const r of Array.isArray(data) ? data : []) {
                if (r?.code === 200 && r?.body) items.push(r.body);
                else if (r?.code === 404) notFound.push(String(r?.body?.id ?? r?.id ?? ''));
            }
        }
        return { items, notFound: notFound.filter(Boolean) };
    }

    /** Una página de ventas de un rango de fechas, para traer el historial. */
    async searchOrdersPage(
        accessToken: string,
        sellerId: string,
        options: { from: Date; to?: Date; offset: number; limit?: number },
    ): Promise<{ results: any[]; total: number }> {
        const fecha = (d: Date) => d.toISOString().replace('Z', '-00:00');
        const { data } = await this.http.get('/orders/search', {
            headers: { Authorization: `Bearer ${accessToken}` },
            params: {
                seller: sellerId,
                'order.date_created.from': fecha(options.from),
                ...(options.to ? { 'order.date_created.to': fecha(options.to) } : {}),
                sort: 'date_desc',
                limit: options.limit ?? 50,
                offset: options.offset,
            },
        });
        return {
            results: Array.isArray(data?.results) ? data.results : [],
            total: Number(data?.paging?.total ?? 0),
        };
    }

    /**
     * Ventas recientes de un vendedor. Sirve para ponerse al día sin depender
     * de las notificaciones de Mercado Libre, que hay que configurar a mano en
     * su panel de desarrolladores y se pierden si el servidor está caído.
     */
    async searchOrders(accessToken: string, sellerId: string, since: Date): Promise<any[]> {
        const { data } = await this.http.get('/orders/search', {
            headers: { Authorization: `Bearer ${accessToken}` },
            params: {
                seller: sellerId,
                'order.date_created.from': since.toISOString().replace('Z', '-00:00'),
                sort: 'date_desc',
                limit: 50,
            },
        });
        return Array.isArray(data?.results) ? data.results : [];
    }

    /** Datos de envío de una venta: estado, seguimiento, dirección y fecha límite de despacho. */
    async getShipment(accessToken: string, shipmentId: string): Promise<any> {
        const { data } = await this.http.get(`/shipments/${shipmentId}`, {
            headers: { Authorization: `Bearer ${accessToken}`, 'x-format-new': 'true' },
        });
        return data;
    }

    async getOrder(accessToken: string, orderId: string): Promise<any> {
        const { data } = await this.http.get(`/orders/${orderId}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        return data;
    }
}
