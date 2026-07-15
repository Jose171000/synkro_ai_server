import { Injectable, InternalServerErrorException } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

export interface MeliTokens {
    accessToken: string;
    refreshToken: string;
    expiresIn: number; // seconds
    externalUserId: string;
}

export interface MeliItemPayload {
    title: string;
    category_id: string;
    price: number;
    currency_id: string;
    available_quantity: number;
    condition: 'new' | 'used';
    listing_type_id: string;
    pictures: { source: string }[];
    attributes?: { id: string; value_name: string }[];
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
        changes: { available_quantity?: number; price?: number },
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

    /** Fetches an order (used when processing sale notifications). */
    async getOrder(accessToken: string, orderId: string): Promise<any> {
        const { data } = await this.http.get(`/orders/${orderId}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        return data;
    }
}
