import { BadRequestException, Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { MarketplaceConnection } from '../entities/marketplace-connection.entity';
import { ListingLink } from '../entities/listing-link.entity';
import { MarketplaceOrder } from '../entities/marketplace-order.entity';
import { Product } from '../../products/entities/product.entity';
import { NotificationsService } from '../../notifications/notifications.service';
import { SyncScope, SyncService } from '../sync.service';
import { WooApiService } from '../woo/woo-api.service';
import { ShopifyApiService } from '../shopify/shopify-api.service';
import { resolverMoneda } from '../../common/currency';
import { OrderLine } from '../order-details';
import {
    ChannelAuth,
    ChannelClient,
    ChannelListingRow,
    ChannelOrder,
    EcommerceChannel,
    ECOMMERCE_CHANNELS,
} from './channel-types';

const NOMBRES: Record<EcommerceChannel, string> = { woocommerce: 'WooCommerce', shopify: 'Shopify' };

/** Por debajo de estas unidades se avisa que un producto se agota. */
const LOW_STOCK_THRESHOLD = 5;
/** Ventana de la consulta periódica: cubre una caída de varias horas y los pagos tardíos. */
const ORDER_LOOKBACK_HOURS = 48;
const POLL_MAX_ORDERS = 250;
/** Tope de ventas por cuenta en una importación de historial. */
const HISTORY_MAX_ORDERS = 600;
const ORDER_KEY_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface EcommerceConnectInput {
    /** WooCommerce: URL de la tienda. Shopify: dominio *.myshopify.com. */
    site: string;
    /** WooCommerce: consumer key. Shopify: token de la Admin API. */
    token: string;
    /** WooCommerce: consumer secret. */
    secret?: string;
    label?: string;
}

/**
 * Importar, mantener al día y sincronizar el stock de las tiendas propias
 * (WooCommerce y Shopify). Es la misma lógica para los dos canales: cada uno
 * aporta un cliente que habla con su API (ChannelClient) y aquí vive todo lo
 * demás, igual que para Mercado Libre y Falabella:
 *  - se enlaza por SKU sin pisar el stock ni el precio de lo que ya existe,
 *  - la revisión periódica solo toca el espejo del canal,
 *  - una venta descuenta el stock y lo manda a los demás canales,
 *  - el historial deja la constancia de las ventas sin mover el stock.
 */
@Injectable()
export class EcommerceSyncService implements OnModuleInit {
    private readonly clients: Record<EcommerceChannel, ChannelClient>;

    constructor(
        private readonly sync: SyncService,
        @InjectRepository(MarketplaceConnection)
        private readonly connections: Repository<MarketplaceConnection>,
        @InjectRepository(ListingLink)
        private readonly links: Repository<ListingLink>,
        @InjectRepository(MarketplaceOrder)
        private readonly orders: Repository<MarketplaceOrder>,
        @InjectRepository(Product)
        private readonly products: Repository<Product>,
        @Inject(REDIS_CLIENT)
        private readonly redis: Redis,
        private readonly notifications: NotificationsService,
        woo: WooApiService,
        shopify: ShopifyApiService,
    ) {
        this.clients = { woocommerce: woo, shopify };
    }

    /** Se da de alta en SyncService para que su consulta periódica, historial y cola lo usen. */
    onModuleInit(): void {
        for (const canal of ECOMMERCE_CHANNELS) {
            this.sync.registerChannel(canal, {
                poll: c => this.poll(c),
                refresh: c => this.refresh(c),
                history: (c, desde, hasta) => this.history(c, desde, hasta),
                pushInventory: (productId, connectionId) => this.pushInventory(canal, productId, connectionId),
            });
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Conectar
    // ─────────────────────────────────────────────────────────────

    private clientOf(marketplace: string): ChannelClient {
        const client = this.clients[marketplace as EcommerceChannel];
        if (!client) throw new BadRequestException(`El canal ${marketplace} no está disponible.`);
        return client;
    }

    /** Credenciales descifradas de una cuenta ya conectada. */
    authOf(connection: MarketplaceConnection): ChannelAuth {
        if (connection.marketplace === 'woocommerce') {
            const secrets = (connection.secrets ?? {}) as { siteUrl?: string; consumerSecret?: string };
            return {
                site: secrets.siteUrl || `https://${connection.externalUserId}`,
                token: connection.accessToken,
                secret: secrets.consumerSecret,
            };
        }
        return { site: connection.externalUserId, token: connection.accessToken };
    }

    async connect(
        scope: SyncScope,
        marketplace: EcommerceChannel,
        input: EcommerceConnectInput,
    ): Promise<{ id: string; marketplace: string; nickname: string; currency: string | null }> {
        const client = this.clientOf(marketplace);
        const site = (input.site ?? '').trim();
        const token = (input.token ?? '').trim();
        const secret = (input.secret ?? '').trim();
        if (!site || !token) {
            throw new BadRequestException(
                marketplace === 'woocommerce'
                    ? 'Faltan la dirección de la tienda o la Consumer Key de WooCommerce.'
                    : 'Faltan el dominio de la tienda o el token de acceso de Shopify.',
            );
        }
        if (marketplace === 'woocommerce' && !secret) {
            throw new BadRequestException('Falta el Consumer Secret de WooCommerce.');
        }

        // Si las credenciales no sirven, esto lanza un error que explica por qué y no se guarda nada.
        const cuenta = await client.verify({ site, token, secret: secret || undefined });

        const connection = await this.sync.findOrCreateConnection(scope, marketplace, cuenta.accountId);
        connection.externalNickname = cuenta.nickname;
        connection.accessToken = token;
        connection.refreshToken = null as any;
        connection.expiresAt = null; // estas claves no caducan
        connection.status = 'active';
        connection.currency = cuenta.currency ?? connection.currency ?? null;
        connection.secrets =
            marketplace === 'woocommerce'
                ? { siteUrl: /^https?:\/\//i.test(site) ? site.replace(/\/+$/, '') : `https://${site.replace(/\/+$/, '')}`, consumerSecret: secret }
                : null;

        const saved = await this.sync.saveConnection(scope, connection, input.label);
        return { id: saved.id, marketplace, nickname: cuenta.nickname, currency: saved.currency ?? null };
    }

    // ─────────────────────────────────────────────────────────────
    // Importar publicaciones
    // ─────────────────────────────────────────────────────────────

    /**
     * Trae lo que la tienda ya tiene publicado y lo enlaza al catálogo por SKU.
     * Con `dryRun` no escribe nada. Un producto que ya existe no se modifica;
     * uno nuevo se crea como borrador. Lo sin SKU no se puede enlazar y se cuenta aparte.
     */
    async importListings(
        scope: SyncScope,
        marketplace: EcommerceChannel,
        connectionId: string | undefined,
        options: { dryRun?: boolean } = {},
    ) {
        const client = this.clientOf(marketplace);
        const connection = await this.sync.resolveConnection(scope.storeId, marketplace, connectionId);
        const lectura = await client.listListings(this.authOf(connection));

        const resumen = {
            publicaciones: lectura.productos,
            total: 0,
            yaEnCatalogo: 0,
            nuevas: 0,
            enlazadas: 0,
            enOtraTienda: 0,
            sinSku: lectura.sinSku,
            incompleto: lectura.incompleto,
            porEstado: {} as Record<string, number>,
            notaMedia: null as number | null,
            ejemplos: [] as { sku: string; nombre: string; estado: string; nota: number | null; enCatalogo: boolean }[],
        };

        for (const fila of lectura.rows) {
            resumen.total++;
            resumen.porEstado[fila.status] = (resumen.porEstado[fila.status] ?? 0) + 1;

            const encontrado = await this.sync.findProductBySku(scope, fila.sku);
            if (encontrado.otraTienda) { resumen.enOtraTienda++; continue; }
            let product = encontrado.product;
            const estabaEnCatalogo = !!product;
            if (estabaEnCatalogo) resumen.yaEnCatalogo++; else resumen.nuevas++;

            if (resumen.ejemplos.length < 10) {
                resumen.ejemplos.push({
                    sku: fila.sku,
                    nombre: fila.title.slice(0, 80),
                    estado: fila.status,
                    nota: null,
                    enCatalogo: estabaEnCatalogo,
                });
            }
            if (options.dryRun) continue;

            if (!product) {
                product = await this.products.save(this.products.create({
                    sku: fila.sku,
                    name: (fila.variation ? `${fila.title} - ${fila.variation}` : fila.title).slice(0, 250),
                    description: '',
                    price: fila.regularPrice ?? undefined,
                    stock: fila.stock,
                    status: 'draft',
                    owner: { id: scope.userId } as any,
                    store: { id: scope.storeId } as any,
                    images: fila.images.slice(0, 10).map(url => ({ url })) as any,
                }));
            }
            await this.guardarEnlace(connection, product, fila);
            resumen.enlazadas++;
        }

        if (!options.dryRun && resumen.enlazadas > 0) {
            const canal = NOMBRES[marketplace];
            await this.notifications.notify(scope.userId, {
                type: 'import',
                severity: lectura.incompleto || resumen.sinSku ? 'warning' : 'success',
                title: `${canal}: ${resumen.enlazadas} publicaciones importadas`,
                body:
                    `${resumen.yaEnCatalogo} ya estaban en tu catálogo y ${resumen.nuevas} se crearon como borrador.` +
                    (resumen.sinSku ? ` ${resumen.sinSku} no tienen SKU y no se pudieron enlazar.` : '') +
                    (lectura.incompleto ? ' El catálogo es muy grande y quedaron productos sin leer.' : ''),
                marketplace,
                meta: { total: resumen.total, porEstado: resumen.porEstado, sinSku: resumen.sinSku },
            });
        }
        return resumen;
    }

    private async guardarEnlace(connection: MarketplaceConnection, product: Product, fila: ChannelListingRow): Promise<void> {
        let enlace = await this.links.findOne({
            where: { product: { id: product.id }, connection: { id: connection.id } },
        });
        if (!enlace) {
            enlace = this.links.create({
                marketplace: connection.marketplace,
                product: { id: product.id } as any,
                connection: { id: connection.id } as any,
            });
        }
        this.aplicarFila(enlace, fila, connection.marketplace as EcommerceChannel);
        await this.links.save(enlace);
    }

    /** Copia a un enlace lo que el canal muestra hoy de la publicación. */
    private aplicarFila(enlace: ListingLink, fila: ChannelListingRow, canal: EcommerceChannel): void {
        enlace.externalId = fila.externalId;
        enlace.variationId = fila.variationId;
        enlace.permalink = fila.permalink ?? enlace.permalink ?? (null as any);
        enlace.syncStatus = fila.status;
        enlace.lastStockSynced = fila.stock;
        enlace.lastPriceSynced = fila.regularPrice as any;
        enlace.regularPrice = fila.regularPrice;
        enlace.salePrice = fila.salePrice;
        enlace.imageUrl = fila.imageUrl;
        enlace.variation = fila.variation;
        enlace.lastSyncedAt = new Date();
        enlace.lastError = fila.status === 'error' ? `${NOMBRES[canal]} marcó la publicación con un problema.` : (null as any);
    }

    // ─────────────────────────────────────────────────────────────
    // Mantener las publicaciones al día
    // ─────────────────────────────────────────────────────────────

    /**
     * Vuelve a leer el catálogo y actualiza el estado, los precios, el stock del
     * canal y la foto de cada enlace. No crea productos ni cambia el stock de Synkro.
     */
    async refresh(connection: MarketplaceConnection): Promise<{ revisadas: number; actualizadas: number; ausentes: number }> {
        const canal = connection.marketplace as EcommerceChannel;
        const enlaces = await this.links.find({
            where: { connection: { id: connection.id }, marketplace: canal },
            relations: { product: true },
        });
        if (!enlaces.length) return { revisadas: 0, actualizadas: 0, ausentes: 0 };

        const lectura = await this.clientOf(canal).listListings(this.authOf(connection));
        const porId = new Map(lectura.rows.map(f => [`${f.externalId}:${f.variationId ?? ''}`, f]));
        const porSku = new Map(lectura.rows.map(f => [f.sku, f]));

        let actualizadas = 0;
        let ausentes = 0;
        for (const enlace of enlaces) {
            const fila = porId.get(`${enlace.externalId}:${enlace.variationId ?? ''}`) ?? porSku.get(enlace.product.sku);
            if (!fila) {
                // Si la lectura quedó a medias, que falte no prueba nada.
                if (!lectura.incompleto) {
                    ausentes++;
                    enlace.syncStatus = 'paused';
                    enlace.lastError = `El producto ya no existe en ${NOMBRES[canal]}.`;
                    await this.links.save(enlace);
                }
                continue;
            }
            this.aplicarFila(enlace, fila, canal);
            await this.links.save(enlace);
            actualizadas++;
        }
        return { revisadas: enlaces.length, actualizadas, ausentes };
    }

    // ─────────────────────────────────────────────────────────────
    // Stock y precio hacia el canal
    // ─────────────────────────────────────────────────────────────

    /** Ejecutado por la cola: envía al canal el stock y el precio actuales de un producto. */
    async pushInventory(canal: EcommerceChannel, productId: string, connectionId?: string): Promise<void> {
        const product = await this.products.findOne({ where: { id: productId } });
        const link = await this.links.findOne({
            where: {
                marketplace: canal,
                product: { id: productId },
                syncStatus: 'published',
                ...(connectionId ? { connection: { id: connectionId } } : {}),
            },
            relations: { connection: true },
        });
        if (!product || !link || !link.connection) return;

        try {
            const connection = await this.sync.getValidConnectionById(link.connection.id);
            await this.clientOf(canal).setInventory(
                this.authOf(connection),
                { externalId: link.externalId, variationId: link.variationId ?? null },
                { stock: product.stock, price: product.price != null ? Number(product.price) : null },
            );
            link.lastStockSynced = product.stock;
            link.lastPriceSynced = product.price;
            link.lastSyncedAt = new Date();
            link.lastError = null as any;
        } catch (error: any) {
            link.lastError = String(error?.message ?? 'No se pudo enviar el stock.').slice(0, 300);
            await this.links.save(link);
            throw error;
        }
        await this.links.save(link);
    }

    // ─────────────────────────────────────────────────────────────
    // Ventas
    // ─────────────────────────────────────────────────────────────

    /** Consulta periódica: ventas modificadas en las últimas horas. */
    async poll(connection: MarketplaceConnection): Promise<{ nuevos: number; revisados: number }> {
        const canal = connection.marketplace as EcommerceChannel;
        const desde = new Date(Date.now() - ORDER_LOOKBACK_HOURS * 3600_000);
        const { orders } = await this.clientOf(canal).listOrders(this.authOf(connection), {
            updatedFrom: desde,
            max: POLL_MAX_ORDERS,
        });

        let nuevos = 0;
        for (const orden of orders) {
            if (await this.aplicarVenta(connection, orden, { soloRegistro: false })) nuevos++;
        }
        if (orders.length) {
            console.log(`[Sync] ${NOMBRES[canal]} ${connection.externalNickname}: ${orders.length} ventas leídas, ${nuevos} nuevas`);
        }
        return { nuevos, revisados: orders.length };
    }

    /** Historial: deja la constancia de ventas ya ocurridas, sin tocar el stock ni avisar. */
    async history(connection: MarketplaceConnection, desde: Date, hasta: Date) {
        const canal = connection.marketplace as EcommerceChannel;
        const { orders, incompleto } = await this.clientOf(canal).listOrders(this.authOf(connection), {
            createdFrom: desde,
            createdTo: hasta,
            max: HISTORY_MAX_ORDERS,
        });
        let registradas = 0;
        let yaRegistradas = 0;
        for (const orden of orders) {
            if (await this.aplicarVenta(connection, orden, { soloRegistro: true })) registradas++;
            else yaRegistradas++;
        }
        return { registradas, yaRegistradas, incompleto };
    }

    /**
     * Registra una venta confirmada y, salvo en el historial, descuenta el stock
     * del producto de cada línea y lo manda a los demás canales. Devuelve true
     * si era nueva. Una venta no pagada o cancelada no se registra todavía: si
     * se paga después, la consulta periódica la verá ya confirmada.
     */
    async aplicarVenta(
        connection: MarketplaceConnection,
        orden: ChannelOrder,
        options: { soloRegistro: boolean },
    ): Promise<boolean> {
        if (!orden.paid) return false;

        const canal = connection.marketplace as EcommerceChannel;
        // Los ids de venta se repiten entre tiendas WooCommerce distintas: se prefija con la tienda.
        const externalId = `${connection.externalUserId}:${orden.externalId}`;
        const dedupeKey = `${canal}:order-applied:${connection.id}:${orden.externalId}`;
        const primeraVez = await this.redis.set(dedupeKey, '1', 'EX', ORDER_KEY_TTL_SECONDS, 'NX');
        if (!primeraVez) return false;

        const userId = connection.owner.id;
        const norm = orden.normalized;
        let guardada: MarketplaceOrder | null = null;
        try {
            guardada = await this.orders.save(this.orders.create({
                marketplace: canal,
                externalId,
                owner: { id: userId } as any,
                store: connection.store ? ({ id: connection.store.id } as any) : null,
                connection: { id: connection.id } as any,
                totalAmount: orden.totalAmount,
                currency: resolverMoneda(orden.currency, connection.currency),
                itemsCount: norm.lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0) || 1,
                items: norm.lines as any,
                orderNumber: norm.orderNumber,
                customerName: norm.customerName,
                shipByDate: norm.shipByDate,
                details: norm.details as any,
                status: orden.channelStatus.slice(0, 30),
                orderDate: orden.orderDate,
            }));
        } catch (error: any) {
            console.warn(`[Sync] Venta ${externalId} de ${NOMBRES[canal]} no persistida: ${error?.message}`);
            // Si el fallo no es «ya existe», se libera la marca para reintentar en la próxima consulta.
            if (error?.code !== '23505') {
                await this.redis.del(dedupeKey);
                return false;
            }
        }
        if (options.soloRegistro) return true;

        const efectos: Record<number, { productId: string; stockBefore: number; stockAfter: number }> = {};
        for (let i = 0; i < norm.lines.length; i++) {
            const linea = norm.lines[i];
            const cantidad = Number(linea.quantity) || 0;
            if (!linea.sku || !cantidad) continue;

            const product = await this.productoDeLaCuenta(connection, linea.sku);
            if (!product) {
                console.warn(`[Sync] Venta ${externalId} de ${NOMBRES[canal]}: el SKU ${linea.sku} no está en el catálogo.`);
                continue;
            }

            const stockAntes = product.stock;
            product.stock = Math.max(0, stockAntes - cantidad);
            await this.products.save(product);
            efectos[i] = { productId: product.id, stockBefore: stockAntes, stockAfter: product.stock };
            console.log(`[Sync] Venta ${NOMBRES[canal]} ${externalId}: ${cantidad}x ${product.sku} → stock ${product.stock}`);

            await this.avisosDeVenta(userId, canal, orden, linea, product, cantidad);
            // El canal de la venta ya descontó solo; los demás reciben el stock nuevo.
            await this.sync.propagateStock(userId, product.id, connection.id);
        }

        if (guardada && Object.keys(efectos).length) {
            await this.orders.update(guardada.id, {
                items: norm.lines.map((l, i) => (efectos[i] ? { ...l, ...efectos[i] } : l)) as any,
            });
        }
        return true;
    }

    /** El producto de la tienda de la cuenta; si es anterior a las tiendas, el del dueño. */
    private async productoDeLaCuenta(connection: MarketplaceConnection, sku: string): Promise<Product | null> {
        const storeId = connection.store?.id;
        return this.products.findOne({
            where: storeId
                ? [{ sku, store: { id: storeId } }, { sku, store: IsNull(), owner: { id: connection.owner.id } }]
                : [{ sku, owner: { id: connection.owner.id } }],
        });
    }

    private async avisosDeVenta(
        userId: string,
        canal: EcommerceChannel,
        orden: ChannelOrder,
        linea: OrderLine,
        product: Product,
        cantidad: number,
    ): Promise<void> {
        const nombre = NOMBRES[canal];
        await this.notifications.notify(userId, {
            type: 'sale',
            severity: 'success',
            title: `Venta en ${nombre}: ${cantidad} x ${product.name}`,
            body:
                `Pedido ${orden.normalized.orderNumber ?? orden.externalId} por ${resolverMoneda(orden.currency)} ` +
                `${orden.totalAmount.toFixed(2)}. Quedan ${product.stock} unidades de ${product.sku}.`,
            marketplace: canal,
            meta: { orderId: orden.externalId, productId: product.id, sku: product.sku, quantity: cantidad },
        });

        // Se avisa al cruzar el umbral, no por debajo, para no repetirlo en cada venta.
        if (product.stock > 0 && product.stock <= LOW_STOCK_THRESHOLD && product.stock + cantidad > LOW_STOCK_THRESHOLD) {
            await this.notifications.notify(userId, {
                type: 'low-stock',
                severity: 'warning',
                title: `Se está agotando: ${product.name}`,
                body: `Quedan ${product.stock} unidades de ${product.sku}. Repone antes de quedarte sin stock publicado.`,
                marketplace: canal,
                meta: { productId: product.id, sku: product.sku, stock: product.stock },
            });
        } else if (product.stock === 0) {
            await this.notifications.notify(userId, {
                type: 'low-stock',
                severity: 'error',
                title: `Sin stock: ${product.name}`,
                body: `${product.sku} se quedó en cero tras la última venta. La publicación dejará de vender.`,
                marketplace: canal,
                meta: { productId: product.id, sku: product.sku, stock: 0 },
            });
        }
    }
}
