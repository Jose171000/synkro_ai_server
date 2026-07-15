import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { MarketplaceConnection } from './entities/marketplace-connection.entity';
import { ListingLink } from './entities/listing-link.entity';
import { Product } from '../products/entities/product.entity';
import { MeliApiService, MeliItemPayload } from './meli/meli-api.service';
import { UpdateInventoryDto } from './dto/update-inventory.dto';

const OAUTH_STATE_TTL_SECONDS = 600; // 10 min to complete the OAuth flow
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

@Injectable()
export class SyncService {
    constructor(
        @InjectRepository(MarketplaceConnection)
        private readonly connectionRepository: Repository<MarketplaceConnection>,
        @InjectRepository(ListingLink)
        private readonly listingLinkRepository: Repository<ListingLink>,
        @InjectRepository(Product)
        private readonly productRepository: Repository<Product>,
        @InjectQueue('marketplace-sync-queue')
        private readonly syncQueue: Queue,
        @Inject(REDIS_CLIENT)
        private readonly redis: Redis,
        private readonly meliApi: MeliApiService,
    ) { }

    // ─────────────────────────────────────────────────────────────
    // OAuth: connect a Mercado Libre seller account
    // ─────────────────────────────────────────────────────────────

    /**
     * Generates the Mercado Libre authorization URL. The random `state` is
     * stored in Redis mapped to the user so the public callback can know
     * which Synkro account initiated the flow (and reject forged callbacks).
     */
    async getMeliAuthUrl(userId: string): Promise<{ authUrl: string }> {
        this.meliApi.assertConfigured();
        const state = randomUUID();
        await this.redis.setex(`meli:oauth-state:${state}`, OAUTH_STATE_TTL_SECONDS, userId);
        return { authUrl: this.meliApi.buildAuthUrl(state) };
    }

    /** Public callback: exchanges the code and persists the connection. */
    async handleMeliCallback(code: string, state: string): Promise<{ marketplace: string; nickname: string }> {
        if (!code || !state) {
            throw new BadRequestException('Faltan los parámetros code y state.');
        }

        const stateKey = `meli:oauth-state:${state}`;
        const userId = await this.redis.get(stateKey);
        if (!userId) {
            throw new BadRequestException('El state de OAuth es inválido o expiró. Vuelve a iniciar la conexión.');
        }
        await this.redis.del(stateKey);

        const tokens = await this.meliApi.exchangeCode(code);
        const profile = await this.meliApi.getMe(tokens.accessToken);

        // Upsert: reconnecting overwrites the previous credentials
        let connection = await this.connectionRepository.findOne({
            where: { marketplace: 'mercadolibre', owner: { id: userId } },
        });
        if (!connection) {
            connection = this.connectionRepository.create({
                marketplace: 'mercadolibre',
                owner: { id: userId } as any,
            });
        }

        connection.externalUserId = tokens.externalUserId;
        connection.externalNickname = profile.nickname;
        connection.accessToken = tokens.accessToken;
        connection.refreshToken = tokens.refreshToken;
        connection.expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);
        connection.status = 'active';

        await this.connectionRepository.save(connection);
        return { marketplace: 'mercadolibre', nickname: profile.nickname };
    }

    async getConnections(userId: string) {
        const connections = await this.connectionRepository.find({
            where: { owner: { id: userId } },
        });
        // Never expose tokens to the frontend
        return connections.map(({ accessToken, refreshToken, ...safe }) => safe);
    }

    async disconnect(userId: string, marketplace: string) {
        const connection = await this.connectionRepository.findOne({
            where: { marketplace, owner: { id: userId } },
        });
        if (!connection) {
            throw new NotFoundException(`No hay una conexión activa con ${marketplace}.`);
        }
        await this.connectionRepository.remove(connection);
        return { message: `Conexión con ${marketplace} eliminada.` };
    }

    /**
     * Returns a valid access token for the user's connection,
     * refreshing it transparently if it is about to expire.
     */
    private async getValidConnection(userId: string, marketplace: string): Promise<MarketplaceConnection> {
        const connection = await this.connectionRepository.findOne({
            where: { marketplace, owner: { id: userId }, status: 'active' },
        });
        if (!connection) {
            throw new BadRequestException(
                `No tienes una cuenta de ${marketplace} conectada. Ve a Marketplaces y conéctala primero.`,
            );
        }

        const needsRefresh = connection.expiresAt.getTime() - Date.now() < TOKEN_REFRESH_MARGIN_MS;
        if (needsRefresh) {
            try {
                const tokens = await this.meliApi.refreshTokens(connection.refreshToken);
                connection.accessToken = tokens.accessToken;
                connection.refreshToken = tokens.refreshToken;
                connection.expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);
                await this.connectionRepository.save(connection);
            } catch (error) {
                connection.status = 'error';
                await this.connectionRepository.save(connection);
                throw new BadRequestException(
                    `La sesión con ${marketplace} expiró y no se pudo renovar. Reconecta tu cuenta.`,
                );
            }
        }

        return connection;
    }

    // ─────────────────────────────────────────────────────────────
    // Publishing
    // ─────────────────────────────────────────────────────────────

    /** Enqueues one publish job per marketplace and returns immediately. */
    async enqueuePublish(productId: string, userId: string, marketplaces: string[]) {
        const product = await this.productRepository.findOne({
            where: { id: productId, owner: { id: userId } },
        });
        if (!product) {
            throw new NotFoundException('Producto no encontrado');
        }
        if (product.price === null || product.price === undefined) {
            throw new BadRequestException('El producto necesita un precio antes de publicarse.');
        }

        for (const marketplace of marketplaces) {
            // Validate the connection now so the user gets an immediate error
            await this.getValidConnection(userId, marketplace);
            await this.syncQueue.add('publish', { productId, userId, marketplace });
        }

        return {
            message: `Publicación encolada en: ${marketplaces.join(', ')}. Recibirás el estado en /sync/products/${productId}/status.`,
        };
    }

    /** Executed by the queue processor: actually publishes on Mercado Libre. */
    async publishToMeli(productId: string, userId: string): Promise<ListingLink> {
        const product = await this.productRepository.findOne({
            where: { id: productId, owner: { id: userId } },
        });
        if (!product) {
            throw new NotFoundException('Producto no encontrado');
        }

        let link = await this.listingLinkRepository.findOne({
            where: { marketplace: 'mercadolibre', product: { id: productId } },
        });
        if (link?.syncStatus === 'published') {
            return link; // already live — inventory updates go through syncInventory
        }
        if (!link) {
            link = this.listingLinkRepository.create({
                marketplace: 'mercadolibre',
                externalId: '',
                product,
                syncStatus: 'pending',
            });
        }

        try {
            const connection = await this.getValidConnection(userId, 'mercadolibre');
            const payload = this.buildMeliItemPayload(product);
            const created = await this.meliApi.createItem(connection.accessToken, payload);

            const description = product.aiDescription || product.description;
            if (description) {
                await this.meliApi.setItemDescription(connection.accessToken, created.id, description);
            }

            link.externalId = created.id;
            link.permalink = created.permalink;
            link.syncStatus = 'published';
            link.lastStockSynced = product.stock;
            link.lastPriceSynced = product.price;
            link.lastSyncedAt = new Date();
            link.lastError = null as any;

            // Keep the product's quick-view fields in sync with reality
            product.marketplaceIds = { ...(product.marketplaceIds || {}), mercadolibre: created.id };
            product.status = 'synced';
            await this.productRepository.save(product);
        } catch (error: any) {
            link.syncStatus = 'error';
            link.lastError = this.describeApiError(error);
            await this.listingLinkRepository.save(link);
            throw error;
        }

        return this.listingLinkRepository.save(link);
    }

    /**
     * Maps an internal product (+ its AI-generated content) to the payload
     * Mercado Libre expects. The category comes from Phase A of the AI
     * pipeline, which stores `mercadolibre_category_id` in marketplaceIds.
     */
    private buildMeliItemPayload(product: Product): MeliItemPayload {
        const categoryId =
            (product.marketplaceIds as any)?.mercadolibre_category_id ||
            (product.aiAttributes as any)?.mercadolibre_category_id;

        if (!categoryId) {
            throw new BadRequestException(
                'El producto no tiene categoría de Mercado Libre. Genera el contenido con IA primero (Fase A de categorización).',
            );
        }

        // ML rejects titles over 60 chars — same rule the AI prompt enforces
        const title = (product.aiTitle || product.name).slice(0, 60);

        return {
            title,
            category_id: categoryId,
            price: Number(product.price),
            currency_id: process.env.MELI_CURRENCY_ID || 'PEN',
            available_quantity: product.stock,
            condition: 'new',
            listing_type_id: process.env.MELI_LISTING_TYPE_ID || 'gold_special',
            pictures: (product.images || []).map(img => ({ source: img.url })),
        };
    }

    // ─────────────────────────────────────────────────────────────
    // Inventory sync (push)
    // ─────────────────────────────────────────────────────────────

    /**
     * Updates local stock/price and enqueues a push to every marketplace
     * where the product is published.
     */
    async updateInventory(productId: string, userId: string, dto: UpdateInventoryDto) {
        if (dto.stock === undefined && dto.price === undefined) {
            throw new BadRequestException('Envía al menos stock o price.');
        }

        const product = await this.productRepository.findOne({
            where: { id: productId, owner: { id: userId } },
        });
        if (!product) {
            throw new NotFoundException('Producto no encontrado');
        }

        if (dto.stock !== undefined) product.stock = dto.stock;
        if (dto.price !== undefined) product.price = dto.price;
        await this.productRepository.save(product);

        const links = await this.listingLinkRepository.find({
            where: { product: { id: productId }, syncStatus: 'published' },
        });

        for (const link of links) {
            await this.syncQueue.add('inventory', {
                productId,
                userId,
                marketplace: link.marketplace,
            });
        }

        return {
            message: links.length
                ? `Inventario actualizado. Sincronizando con: ${links.map(l => l.marketplace).join(', ')}.`
                : 'Inventario actualizado localmente. El producto aún no está publicado en ningún marketplace.',
        };
    }

    /** Executed by the queue processor: pushes current stock/price to Mercado Libre. */
    async pushInventoryToMeli(productId: string, userId: string): Promise<void> {
        const product = await this.productRepository.findOne({
            where: { id: productId, owner: { id: userId } },
        });
        const link = await this.listingLinkRepository.findOne({
            where: { marketplace: 'mercadolibre', product: { id: productId }, syncStatus: 'published' },
        });
        if (!product || !link) return;

        try {
            const connection = await this.getValidConnection(userId, 'mercadolibre');
            await this.meliApi.updateItem(connection.accessToken, link.externalId, {
                available_quantity: product.stock,
                price: Number(product.price),
            });
            link.lastStockSynced = product.stock;
            link.lastPriceSynced = product.price;
            link.lastSyncedAt = new Date();
            link.lastError = null as any;
        } catch (error: any) {
            link.lastError = this.describeApiError(error);
            await this.listingLinkRepository.save(link);
            throw error;
        }
        await this.listingLinkRepository.save(link);
    }

    // ─────────────────────────────────────────────────────────────
    // Webhooks (pull): a sale on Mercado Libre lowers local stock
    // ─────────────────────────────────────────────────────────────

    /**
     * Entry point for Mercado Libre notifications. We only react to order
     * topics; everything else is acknowledged and ignored. Processing is
     * deferred to the queue so ML gets its 200 within 500ms as required.
     */
    async handleMeliNotification(body: any): Promise<{ received: boolean }> {
        const topic = body?.topic || body?.type;
        if (topic === 'orders_v2' || topic === 'orders') {
            await this.syncQueue.add('meli-order', {
                resource: body.resource, // e.g. '/orders/2000003508419500'
                meliUserId: String(body.user_id),
            });
        }
        return { received: true };
    }

    /** Executed by the queue processor: applies a Mercado Libre sale to local stock. */
    async processMeliOrder(resource: string, meliUserId: string): Promise<void> {
        const connection = await this.connectionRepository.findOne({
            where: { marketplace: 'mercadolibre', externalUserId: meliUserId, status: 'active' },
            relations: { owner: true },
        });
        if (!connection) {
            console.warn(`[Sync] Notificación de ML para un seller no conectado: ${meliUserId}`);
            return;
        }

        const userId = connection.owner.id;
        const orderId = resource.split('/').pop() as string;
        const validConnection = await this.getValidConnection(userId, 'mercadolibre');
        const order = await this.meliApi.getOrder(validConnection.accessToken, orderId);

        if (order.status !== 'paid') return; // only confirmed sales move stock

        // Idempotency: never apply the same order twice (webhooks can repeat)
        const dedupeKey = `meli:order-applied:${orderId}`;
        const firstTime = await this.redis.set(dedupeKey, '1', 'EX', 60 * 60 * 24 * 30, 'NX');
        if (!firstTime) return;

        for (const orderItem of order.order_items || []) {
            const externalId = orderItem?.item?.id;
            const quantity = Number(orderItem?.quantity || 0);
            if (!externalId || !quantity) continue;

            const link = await this.listingLinkRepository.findOne({
                where: { marketplace: 'mercadolibre', externalId },
                relations: { product: true },
            });
            if (!link) continue;

            const product = link.product;
            product.stock = Math.max(0, product.stock - quantity);
            await this.productRepository.save(product);
            console.log(`[Sync] Venta ML ${orderId}: ${quantity}x ${product.sku} → stock ${product.stock}`);

            // Propagate the new stock to every OTHER channel where it's published
            const otherLinks = await this.listingLinkRepository.find({
                where: { product: { id: product.id }, syncStatus: 'published' },
            });
            for (const other of otherLinks) {
                if (other.marketplace === 'mercadolibre') continue;
                await this.syncQueue.add('inventory', {
                    productId: product.id,
                    userId,
                    marketplace: other.marketplace,
                });
            }
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Status
    // ─────────────────────────────────────────────────────────────

    async getProductSyncStatus(productId: string, userId: string) {
        const product = await this.productRepository.findOne({
            where: { id: productId, owner: { id: userId } },
        });
        if (!product) {
            throw new NotFoundException('Producto no encontrado');
        }
        const links = await this.listingLinkRepository.find({
            where: { product: { id: productId } },
        });
        return {
            productId,
            sku: product.sku,
            stock: product.stock,
            price: product.price,
            listings: links.map(l => ({
                marketplace: l.marketplace,
                externalId: l.externalId,
                permalink: l.permalink,
                syncStatus: l.syncStatus,
                lastStockSynced: l.lastStockSynced,
                lastPriceSynced: l.lastPriceSynced,
                lastSyncedAt: l.lastSyncedAt,
                lastError: l.lastError,
            })),
        };
    }

    private describeApiError(error: any): string {
        const apiMessage = error?.response?.data?.message;
        const causes = error?.response?.data?.cause
            ?.map((c: any) => c?.message)
            .filter(Boolean)
            .join('; ');
        return [apiMessage, causes].filter(Boolean).join(' — ') || error?.message || 'Error desconocido';
    }
}
