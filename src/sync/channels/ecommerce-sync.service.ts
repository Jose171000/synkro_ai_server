import { RipleyCatalogoService } from '../ripley/ripley-catalogo.service';
import { BadRequestException, Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, IsNull, Repository } from 'typeorm';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { MarketplaceConnection } from '../entities/marketplace-connection.entity';
import { ListingLink } from '../entities/listing-link.entity';
import { MarketplaceOrder } from '../entities/marketplace-order.entity';
import { Product } from '../../products/entities/product.entity';
import { SaleAlertsService } from '../sale-alerts.service';
import { ventaAnteriorALaConexion } from '../venta-anterior-a-la-conexion';
import { NotificationsService } from '../../notifications/notifications.service';
import { OpcionesDeEnvio, SyncScope, SyncService } from '../sync.service';
import { firmaDePromo, preciosParaCanal } from '../precios-por-canal';
import { WooApiService } from '../woo/woo-api.service';
import { ShopifyApiService } from '../shopify/shopify-api.service';
import { RipleyApiService } from '../ripley/ripley-api.service';
import { planearGruposDeRipley } from '../ripley/variantes-ripley';
import { armarOfertaParaEnviar, resumenDeCambios, ripleyEnviaPrecio, skuPermitidoParaRipley } from '../ripley/ripley-oferta';
import type { ColoresDeFamilia, FamiliaParaColores } from '../../ai/product-vision.service';

/** Cuántas familias se miran con IA por petición (cada una es una llamada de visión). */
export const MAX_FAMILIAS_PARA_COLORES = 8;
import { EntradaManual, FalabellaVariantImportService, ResultadoDeAgrupar } from '../falabella-variant-import.service';
import { GrupoSinResolver } from '../falabella/variantes-falabella';
import { HOST_DE_RIPLEY_POR_DEFECTO, esFotoDeMirakl, filaDeOfertaRipley, normalizarClaveDeRipley, normalizarHostDeRipley } from '../ripley/ripley-mapping';
import { resolverMoneda } from '../../common/currency';
import { importeDeProductos, OrderLine } from '../order-details';
import {
    ChannelAuth,
    ChannelClient,
    ChannelListingRow,
    ChannelOrder,
    EcommerceChannel,
    ECOMMERCE_CHANNELS,
} from './channel-types';

const NOMBRES: Record<EcommerceChannel, string> = { woocommerce: 'WooCommerce', shopify: 'Shopify', ripley: 'Ripley' };

/**
 * Mandar stock y precio a Ripley está apagado hasta probarlo con la tienda real (POST /api/offers reemplaza la oferta entera).
 * Se enciende con RIPLEY_PUSH_ENABLED=true.
 */
const ripleyPuedeEscribir = () => process.env.RIPLEY_PUSH_ENABLED === 'true';

/** Por debajo de estas unidades se avisa que un producto se agota. */
const LOW_STOCK_THRESHOLD = 5;
/** Ventana de la consulta periódica: cubre una caída de varias horas y los pagos tardíos. */
const ORDER_LOOKBACK_HOURS = 48;
const POLL_MAX_ORDERS = 250;
/** Tope de ventas por cuenta en una importación de historial. */
const HISTORY_MAX_ORDERS = 600;
const ORDER_KEY_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface EcommerceConnectInput {
    /** WooCommerce: URL de la tienda. Shopify: dominio *.myshopify.com. Ripley: dirección del portal (*.mirakl.net; vacío = Perú). */
    site: string;
    /** WooCommerce: consumer key. Shopify: token de la Admin API. Ripley: la clave de API de la tienda. */
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
        private readonly saleAlerts: SaleAlertsService,
        woo: WooApiService,
        shopify: ShopifyApiService,
        ripley: RipleyApiService,
        @Optional() private readonly variantImport?: FalabellaVariantImportService,
        @Optional() private readonly ripleyCatalogo?: RipleyCatalogoService,
    ) {
        this.clients = { woocommerce: woo, shopify, ripley };
    }

    /** Se da de alta en SyncService para que su consulta periódica, historial y cola lo usen. */
    onModuleInit(): void {
        for (const canal of ECOMMERCE_CHANNELS) {
            this.sync.registerChannel(canal, {
                poll: c => this.poll(c),
                refresh: c => this.refresh(c),
                history: (c, desde, hasta) => this.history(c, desde, hasta),
                // Ripley todavía solo se lee: aunque un producto esté enlazado, su stock no se manda hasta activarlo.
                pushInventory: (productId, connectionId, opciones) => (
                    canal === 'ripley' && !ripleyPuedeEscribir()
                        ? Promise.resolve({ omitido: 'El envío a Ripley está apagado: el cambio no se mandó a Ripley.' })
                        : this.pushInventory(canal, productId, connectionId, opciones)
                ),
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
        if (connection.marketplace === 'ripley') {
            const secrets = (connection.secrets ?? {}) as { site?: string };
            return { site: secrets.site || HOST_DE_RIPLEY_POR_DEFECTO, token: connection.accessToken };
        }
        return { site: connection.externalUserId, token: connection.accessToken };
    }

    /**
     * Sugerencia de color por foto para las familias de Ripley que no se pudieron resolver por el título. No escribe nada:
     * la persona revisa cada sugerencia antes de aplicarla. Solo se miran fotos servidas por Mirakl (nunca direcciones ajenas).
     */
    async sugerirColoresDeRipley(familias: FamiliaParaColores[]): Promise<ColoresDeFamilia[]> {
        if (!this.sync.coloresConIA) throw new BadRequestException('La sugerencia de colores con IA no está disponible en este momento.');
        const validas = familias
            .slice(0, MAX_FAMILIAS_PARA_COLORES)
            .map((f) => ({
                parentSku: String(f.parentSku ?? '').slice(0, 120),
                fichas: (f.fichas ?? []).slice(0, 24).map((x) => ({ sku: String(x.sku ?? ''), nombre: String(x.nombre ?? '').slice(0, 200), imagen: esFotoDeMirakl(x.imagen) ? x.imagen : '' })),
            }))
            .filter((f) => f.parentSku && f.fichas.length >= 2);
        if (!validas.length) return [];
        return this.sync.coloresConIA(validas);
    }

    /** SOLO LECTURA: lo que Ripley dice sobre variantes, categorías y atributos (reconocimiento previo al agrupado de variantes). */
    async diagnosticoDeRipley(scope: SyncScope, connectionId?: string) {
        const connection = await this.sync.resolveConnection(scope.storeId, 'ripley', connectionId);
        return (this.clientOf('ripley') as RipleyApiService).diagnostico(this.authOf(connection));
    }

    /** SOLO LECTURA: categorías de Ripley y los atributos que cada una exige (reconocimiento previo a publicar productos). */
    async categoriasDeRipley(scope: SyncScope, filtro: { buscar?: string; codigo?: string; conValores?: boolean; buscarValor?: string; lista?: string }, connectionId?: string) {
        const connection = await this.sync.resolveConnection(scope.storeId, 'ripley', connectionId);
        return (this.clientOf('ripley') as RipleyApiService).catalogoDeCategoria(this.authOf(connection), filtro);
    }

    /**
     * SOLO LECTURA. Muestra, para un SKU, la oferta que Ripley tiene hoy y exactamente qué se enviaría con el stock (y el precio,
     * si está permitido) de Synkro. No envía nada. Sirve para revisar el piloto antes de encender el envío.
     */
    async vistaPreviaDeEnvioRipley(scope: SyncScope, sku: string, connectionId?: string) {
        const limpio = (sku ?? '').trim();
        if (!limpio) throw new BadRequestException('Falta el SKU.');
        const connection = await this.sync.resolveConnection(scope.storeId, 'ripley', connectionId);
        const producto = await this.products.findOne({ where: { sku: limpio, store: { id: scope.storeId } } });
        const enlace = producto
            ? await this.links.findOne({ where: { marketplace: 'ripley', product: { id: producto.id }, connection: { id: connection.id } } })
            : null;
        const actual = await (this.clientOf('ripley') as RipleyApiService).ofertaPorSku(this.authOf(connection), limpio);
        // Ripley manda un campo por vez: aquí se ve lo que saldría de stock y, aparte, lo que saldría de precio.
        const precioDeSynkro = producto && enlace ? Number(preciosParaCanal(producto as any, enlace as any).price) : null;
        let seEnviaria: Record<string, any> | null = null;
        let seEnviariaPrecio: Record<string, any> | null = null;
        let problema: string | null = null;
        let problemaPrecio: string | null = null;
        try { seEnviaria = armarOfertaParaEnviar(actual, { stock: producto ? producto.stock : null, price: null }); } catch (e: any) { problema = e?.message ?? 'No se puede armar la oferta.'; }
        if (precioDeSynkro != null) {
            try { seEnviariaPrecio = armarOfertaParaEnviar(actual, { stock: null, price: precioDeSynkro }); } catch (e: any) { problemaPrecio = e?.message ?? 'No se puede armar la oferta.'; }
        }
        if (!producto) problema = problema ?? 'Ese SKU no existe como producto de esta tienda en Synkro.';
        else if (!enlace) problema = problema ?? 'El producto no está enlazado a esa oferta de Ripley.';
        else if (String(enlace.externalId) !== String(actual.offer_id)) problema = 'El enlace apunta a otra oferta de Ripley que la que tiene este SKU.';
        return {
            sku: limpio,
            envioEncendido: ripleyPuedeEscribir(),
            skuPermitido: skuPermitidoParaRipley(limpio),
            precioSeEnvia: ripleyEnviaPrecio(),
            problema,
            enSynkro: producto ? { stock: producto.stock, precio: producto.price != null ? Number(producto.price) : null } : null,
            cambios: seEnviaria ? resumenDeCambios(actual, seEnviaria) : null,
            ofertaActualEnRipley: actual,
            seEnviaria,
            // El envío de precio: solo cambia el precio (el stock de Ripley se conserva). Con rebaja en Ripley no se envía.
            problemaPrecio,
            cambiosPrecio: seEnviariaPrecio ? resumenDeCambios(actual, seEnviariaPrecio) : null,
            seEnviariaPrecio,
        };
    }

    async connect(
        scope: SyncScope,
        marketplace: EcommerceChannel,
        input: EcommerceConnectInput,
    ): Promise<{ id: string; marketplace: string; nickname: string; currency: string | null }> {
        const client = this.clientOf(marketplace);
        const esRipley = marketplace === 'ripley';
        // Ripley: la dirección se valida (solo *.mirakl.net) y, si va vacía, es la de Perú.
        const site = esRipley ? normalizarHostDeRipley(input.site) : (input.site ?? '').trim();
        const token = esRipley ? normalizarClaveDeRipley(input.token) : (input.token ?? '').trim();
        const secret = (input.secret ?? '').trim();
        if (!esRipley && (!site || !token)) {
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
                : esRipley
                    ? { site }
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
        options: { dryRun?: boolean; gruposManuales?: EntradaManual[] } = {},
    ) {
        const client = this.clientOf(marketplace);
        const connection = await this.sync.resolveConnection(scope.storeId, marketplace, connectionId);
        const lectura = await client.listListings(this.authOf(connection));
        // Ripley no trae fotos en sus ofertas: se piden aparte (solo lectura) para los productos nuevos y para las fichas de «Estructurar».
        if (marketplace === 'ripley') {
            const fotos = await (client as RipleyApiService).fotosDeProductos(this.authOf(connection), lectura.rows.map((r) => r.productSku ?? ''));
            for (const fila of lectura.rows) {
                const url = fila.productSku ? fotos.get(fila.productSku) : undefined;
                if (url) { fila.imageUrl = url; fila.images = [url]; }
            }
        }

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
            // Solo Ripley: ofertas del mismo producto del catálogo de Ripley, agrupadas como variantes.
            variantes: undefined as undefined | {
                grupos: number;
                variantes: number;
                ejemplos: { parentSku: string; nombre: string; ejes: { name: string; values: string[] }[]; variantes: number }[];
                sinResolver: GrupoSinResolver[];
                aplicado?: ResultadoDeAgrupar;
                manuales?: ResultadoDeAgrupar;
            },
        };

        // Las familias de variantes (solo Ripley por ahora). Las que la persona estructuró a mano mandan sobre las automáticas.
        const manuales = options.gruposManuales ?? [];
        const plan = marketplace === 'ripley' ? planearGruposDeRipley(lectura.rows) : null;
        const grupos = (plan?.grupos ?? []).filter((g) => !manuales.some((m) => m.parentSku === g.parentSku));
        if (plan) {
            resumen.variantes = {
                grupos: grupos.length,
                variantes: grupos.reduce((n, g) => n + g.variants.length, 0),
                ejemplos: grupos.slice(0, 8).map((g) => ({ parentSku: g.parentSku, nombre: g.name, ejes: g.axes, variantes: g.variants.length })),
                sinResolver: plan.sinResolver,
            };
        }
        const vinculados = new Map<string, Product>();

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
                    importedFrom: marketplace,
                    owner: { id: scope.userId } as any,
                    store: { id: scope.storeId } as any,
                    images: fila.images.slice(0, 10).map(url => ({ url })) as any,
                }));
            }
            await this.guardarEnlace(connection, product, fila);
            if (marketplace === 'ripley') await this.guardarCategoriaDeRipley(product, fila);
            vinculados.set(fila.sku, product);
            resumen.enlazadas++;
        }

        // Con los productos ya creados o enlazados, se agrupan en el mismo paso (nunca se tocan fotos, precio ni stock).
        if (!options.dryRun && plan && this.variantImport && resumen.variantes) {
            if (grupos.length) resumen.variantes.aplicado = await this.variantImport.aplicar(scope, grupos, vinculados);
            if (manuales.length) resumen.variantes.manuales = await this.variantImport.aplicarManuales(scope, manuales, vinculados);
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
                storeId: scope.storeId,
            });
        }
        return resumen;
    }

    /**
     * Enlaza UN producto de Synkro con SU oferta de Ripley (por SKU), sin importar nada más: no crea productos, no agrupa variantes y
     * no toca el resto del catálogo. Sirve después de publicar un producto nuevo desde Synkro. Solo escribe el vínculo.
     */
    async enlazarOfertaDeRipley(scope: SyncScope, productId: string, connectionId?: string) {
        const product = await this.sync.findScopedProduct(scope, productId);
        const connection = await this.sync.resolveConnection(scope.storeId, 'ripley', connectionId);
        const oferta = await (this.clientOf('ripley') as RipleyApiService).ofertaPorSku(this.authOf(connection), product.sku);
        const fila = filaDeOfertaRipley(oferta, (connection as any).currency ?? null);
        if (!fila || fila.sku !== product.sku) throw new BadRequestException(`La oferta de Ripley no corresponde al SKU «${product.sku}».`);
        await this.guardarEnlace(connection, product, fila);
        await this.guardarCategoriaDeRipley(product, fila);
        return { enlazado: true, sku: product.sku, offerId: fila.externalId, estado: fila.status, stock: fila.stock, precio: fila.regularPrice };
    }

    /** La categoría que la oferta ya tiene en Ripley, solo si el producto todavía no tiene una (lo elegido en Synkro manda). */
    private async guardarCategoriaDeRipley(product: Product, fila: ChannelListingRow): Promise<void> {
        const ids: Record<string, any> = (product.marketplaceIds as any) || {};
        if (!fila.categoryCode || ids.ripley_category_id) return;
        // La ruta completa sale del catálogo importado; si el código no está en él, se muestra el nombre que da la oferta.
        const ruta = await this.ripleyCatalogo?.rutaDe(fila.categoryCode).catch(() => null);
        const marketplaceIds = { ...ids, ripley_category_id: fila.categoryCode, ripley_category_path: ruta ?? fila.categoryLabel ?? fila.categoryCode };
        await this.products.update(product.id, { marketplaceIds } as any);
        product.marketplaceIds = marketplaceIds as any;
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
        // Productos ya enviados a Ripley antes de que el envío dejara su publicación «en proceso»: se vinculan para que se vean.
        if (canal === 'ripley') await this.vincularEnviosSinEnlace(connection).catch((error: any) => console.warn(`[Sync] Envíos a Ripley sin publicación: ${error?.message}`));
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
        let enviosRevisados = 0;
        for (const enlace of enlaces) {
            const fila = porId.get(`${enlace.externalId}:${enlace.variationId ?? ''}`) ?? porSku.get(enlace.product.sku);
            // Ripley: un envío que espera su aprobación todavía no tiene oferta; no es «ausente». Se mira si Ripley lo rechazó.
            if (!fila && canal === 'ripley' && enlace.syncStatus === 'pending') {
                if (enviosRevisados < 10) {
                    enviosRevisados++;
                    await this.revisarEnvioPendienteDeRipley(connection, enlace).catch((error: any) => console.warn(`[Sync] Envío pendiente de Ripley (${enlace.product.sku}): ${error?.message}`));
                }
                continue;
            }
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

    /** Los productos de la tienda que ya se enviaron a esta cuenta de Ripley y todavía no tienen publicación se registran como «en proceso». */
    private async vincularEnviosSinEnlace(connection: MarketplaceConnection): Promise<void> {
        const filas: { id: string }[] = await this.links.manager.query(
            `SELECT p.id FROM products p JOIN marketplace_connections c ON c.id = $1
             WHERE p."storeId" = c."storeId" AND (p."aiAttributes"::jsonb) ? 'ripley_envio'
               AND NOT EXISTS (SELECT 1 FROM listing_links l WHERE l."productId" = p.id AND l."connectionId" = c.id)`,
            [connection.id],
        );
        for (const f of filas) {
            await this.links.save(this.links.create({ marketplace: 'ripley', externalId: '', product: { id: f.id } as any, connection: { id: connection.id } as any, syncStatus: 'pending' }));
        }
    }

    /**
     * Un producto enviado a Ripley que aún no tiene oferta: si Ripley rechazó su envío (ofertas o productos con errores), la publicación
     * pasa a «error» con el motivo; si sigue en curso o terminó bien, se deja en proceso (la oferta aparecerá cuando lo apruebe).
     */
    private async revisarEnvioPendienteDeRipley(connection: MarketplaceConnection, enlace: ListingLink): Promise<void> {
        const envio = ((enlace.product?.aiAttributes as any) ?? {}).ripley_envio as { importId?: string | number; productImportId?: string | number | null } | undefined;
        if (!envio?.importId) return;
        const api = this.clientOf('ripley') as RipleyApiService;
        const auth = this.authOf(connection);
        const ofertas = await api.estadoDeImportacion(auth, envio.importId);
        const productos = envio.productImportId ? await api.estadoDeProductos(auth, envio.productImportId).catch(() => null) : null;
        const falloOfertas = String(ofertas?.status ?? '').toUpperCase() === 'FAILED' || Number(ofertas?.lines_in_error) > 0;
        const falloProductos = Number(productos?.lines_in_error ?? productos?.transform_lines_in_error) > 0;
        if (!falloOfertas && !falloProductos) return;
        const detalle = falloProductos && envio.productImportId
            ? await api.reporteDeErrores(auth, 'productos', envio.productImportId, 3).catch(() => [] as string[])
            : await api.reporteDeErrores(auth, 'ofertas', envio.importId, 3).catch(() => [] as string[]);
        enlace.syncStatus = 'error';
        enlace.lastError = `Ripley rechazó el envío (importación ${envio.importId})${detalle.length ? `: ${detalle.join(' · ')}` : '.'}`.slice(0, 500);
        await this.links.save(enlace);
    }

    // ─────────────────────────────────────────────────────────────
    // Stock y precio hacia el canal
    // ─────────────────────────────────────────────────────────────

    /**
     * Ejecutado por la cola: envía al canal el stock y el precio actuales de un producto.
     * WooCommerce y Shopify mandan los dos siempre. Ripley manda un solo campo por vez: sin opciones va el stock; con `conPrecio`
     * va el precio (y el stock solo si `conStock`). Lo que no se manda queda como lo tiene Ripley.
     */
    async pushInventory(canal: EcommerceChannel, productId: string, connectionId?: string, opciones?: OpcionesDeEnvio): Promise<void | { omitido: string }> {
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
        const esRipley = canal === 'ripley';
        // Un cambio de descuento manda solo el descuento: ni el stock ni el precio de lista se tocan.
        let conDescuento = esRipley && !!opciones?.conDescuento && !!opciones?.descuento;
        let conPrecio = esRipley ? !!opciones?.conPrecio && !conDescuento : true;
        const conStock = esRipley ? (opciones?.conStock ?? (!conPrecio && !conDescuento)) : true;
        if (esRipley) {
            // Solo salen los SKU de la lista RIPLEY_PUSH_SKUS («*» = todos); el precio solo si RIPLEY_PUSH_PRICE=true.
            if (!skuPermitidoParaRipley(product.sku)) {
                console.log(`[Sync] Ripley: el SKU ${product.sku} no está en RIPLEY_PUSH_SKUS; no se envió nada.`);
                return { omitido: `El SKU ${product.sku} todavía no está habilitado para enviar a Ripley (piloto): el cambio no se mandó a Ripley.` };
            }
            if ((conPrecio || conDescuento) && !ripleyEnviaPrecio()) {
                if (!conStock) return { omitido: 'El envío de precios a Ripley está apagado: el cambio de precio o descuento no se mandó a Ripley.' };
                conPrecio = false;
                conDescuento = false;
            }
            if (!conPrecio && !conDescuento && !conStock) return;
        }
        const descuento = conDescuento ? opciones!.descuento! : null;
        // El precio normal de este canal: el fijado para la cuenta o, si no hay, el del producto (la rebaja de Ripley no se toca).
        // En todos los canales, el precio fijado para esta cuenta; si no hay, el del producto.
        const precioDeCuenta = preciosParaCanal(product as any, link as any).price;
        const precio = precioDeCuenta != null ? Number(precioDeCuenta) : null;

        // WooCommerce: el descuento general viaja con cada envío. Solo se quita si lo puso Synkro antes (lastPromoSynced):
        // una oferta que la tienda tenga por su cuenta no se borra.
        let descuentoWoo: { precio: number | null; desde?: string | null; hasta?: string | null } | null = null;
        let firmaWoo: string | null = null;
        if (canal === 'woocommerce') {
            const precios = preciosParaCanal(product as any, link as any);
            // Lo que la tienda ya muestra (leído en la última revisión) no es del descuento de Synkro: si no, un descuento quitado
            // se volvería a mandar a sí mismo y nunca se retiraría.
            const promo = precios.origen.promo === 'canal' ? null : precios.promo;
            if (promo) {
                descuentoWoo = { precio: promo.salePrice, desde: promo.start, hasta: promo.end };
                firmaWoo = firmaDePromo(promo);
            } else if (link.lastPromoSynced) {
                descuentoWoo = { precio: null };
                firmaWoo = '';
            }
        }

        try {
            const connection = await this.sync.getValidConnectionById(link.connection.id);
            await this.clientOf(canal).setInventory(
                this.authOf(connection),
                { externalId: link.externalId, variationId: link.variationId ?? null, ...(esRipley ? { sku: product.sku } : {}) },
                { stock: conStock ? product.stock : null, price: conPrecio ? precio : null, ...(descuento ? { descuento } : descuentoWoo ? { descuento: descuentoWoo } : {}) },
            );
            if (firmaWoo !== null) {
                link.lastPromoSynced = (firmaWoo || null) as any;
                // Lo que la tienda muestra ahora: el descuento puesto, o ninguno si se retiró (el tablero lo enseña tachado o no).
                link.salePrice = (descuentoWoo?.precio ?? null) as any;
            }
            if (conStock) link.lastStockSynced = product.stock;
            if (conPrecio) {
                link.lastPriceSynced = precio as any;
                if (esRipley) link.regularPrice = precio;
            }
            if (descuento) {
                // Lo que quedó en Ripley y lo que se pidió para esta cuenta (la próxima revisión lo confirma con lo que lea del canal).
                link.salePrice = descuento.precio as any;
                link.salePriceOverride = descuento.precio as any;
                link.saleStartOverride = (descuento.precio === null ? null : descuento.desde ?? null) as any;
                link.saleEndOverride = (descuento.precio === null ? null : descuento.hasta ?? null) as any;
            }
            link.lastSyncedAt = new Date();
            link.lastError = null as any;
        } catch (error: any) {
            link.lastError = String(error?.message ?? 'No se pudo enviar el stock.').slice(0, 300);
            await this.links.save(link);
            throw error;
        }
        await this.links.save(link);
    }

    /**
     * Pausar, reanudar o quitar UNA oferta de Ripley desde Synkro. Pausar deja el stock en 0 (la oferta queda inactiva); reanudar vuelve a
     * mandar el stock real; quitar borra la oferta (el producto sigue en el catálogo de Ripley). Solo para SKU habilitados (RIPLEY_PUSH_SKUS).
     */
    async accionSobreOfertaDeRipley(enlace: ListingLink, accion: 'pause' | 'resume' | 'remove'): Promise<void> {
        const product = enlace.product;
        if (!product || !enlace.connection) throw new BadRequestException('Falta el producto o la cuenta de Ripley.');
        if (!skuPermitidoParaRipley(product.sku)) {
            throw new BadRequestException(`El SKU ${product.sku} todavía no está habilitado para controlarlo desde Synkro en Ripley (piloto).`);
        }
        if (!enlace.externalId) throw new BadRequestException('Esta publicación todavía no tiene su oferta enlazada en Ripley.');
        const connection = await this.sync.getValidConnectionById(enlace.connection.id);
        const auth = this.authOf(connection);
        const cliente = this.clientOf('ripley') as RipleyApiService;
        const destino = { externalId: enlace.externalId, variationId: null, sku: product.sku };
        if (accion === 'pause') await cliente.setInventory(auth, destino, { stock: 0 });
        else if (accion === 'resume') await cliente.setInventory(auth, destino, { stock: Math.max(0, Number(product.stock) || 0) });
        else await cliente.quitarOferta(auth, destino);
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
            console.log(`[Sync] ${NOMBRES[canal]} ${connection.externalNickname}: ${orders.length} ventas leídas, ${nuevos} nuevas${this.desglosePorEstado(canal, orders)}`);
        } else if (canal === 'ripley') {
            // Ripley no avisa por webhook y la consulta es silenciosa: este renglón confirma que la pasada corrió y que no había pedidos.
            console.log(`[Sync] Ripley ${connection.externalNickname}: 0 pedidos modificados en las últimas ${ORDER_LOOKBACK_HOURS} h`);
        }
        return { nuevos, revisados: orders.length };
    }

    /** Solo para Ripley: cuántos pedidos hay en cada estado del canal, para entender por qué una venta cuenta o no. */
    private desglosePorEstado(canal: EcommerceChannel, orders: ChannelOrder[]): string {
        if (canal !== 'ripley') return '';
        const porEstado = new Map<string, number>();
        for (const o of orders) porEstado.set(o.channelStatus, (porEstado.get(o.channelStatus) ?? 0) + 1);
        const texto = [...porEstado].map(([estado, n]) => `${estado}=${n}`).join(', ');
        return ` [${texto}; cuentan como venta: ${orders.filter(o => o.paid).length}]`;
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
        if (canal === 'ripley') {
            console.log(`[Sync] Historial de Ripley ${connection.externalNickname}: ${orders.length} pedidos leídos, ${registradas} registrados${this.desglosePorEstado(canal, orders)}`);
        }
        return { registradas, yaRegistradas, incompleto };
    }

    /**
     * Registra una venta confirmada y, salvo en el historial, descuenta el stock
     * del producto de cada línea y lo manda a los demás canales. Devuelve true
     * si era nueva. Una venta no pagada o cancelada solo se guarda si el canal lo
     * pide (`registrarSinPago`): se ve en Ventas, sin stock ni avisos, hasta que se pague.
     */
    async aplicarVenta(
        connection: MarketplaceConnection,
        orden: ChannelOrder,
        options: { soloRegistro: boolean },
    ): Promise<boolean> {
        const canal = connection.marketplace as EcommerceChannel;
        // Los ids de venta se repiten entre tiendas WooCommerce distintas: se prefija con la tienda.
        const externalId = `${connection.externalUserId}:${orden.externalId}`;

        // Un canal que informa el estado de la venta (Ripley): si ya la teníamos, solo se refleja lo que cambió en el canal
        // (aceptada, enviada, recibida, cancelada…). Va antes de «no pagada» porque una venta registrada puede cancelarse después.
        if (orden.saleState) {
            const registrada = await this.orders.findOne({ where: { marketplace: canal, externalId, connection: { id: connection.id } } });
            if (registrada) {
                const sinAplicar = !!(registrada.details as any)?.noAplicada;
                if (sinAplicar && orden.paid) return this.confirmarPago(connection, registrada, orden, options);
                // Una venta que ya descontó stock no vuelve a «sin pagar» porque la tienda la ponga en espera.
                if (!sinAplicar && orden.saleState === 'sin_pagar') return false;
                await this.reflejarEstado(registrada, orden);
                return false;
            }
        }
        if (!orden.paid) return orden.registrarSinPago ? this.guardarSinPago(connection, externalId, orden) : false;

        const dedupeKey = `${canal}:order-applied:${connection.id}:${orden.externalId}`;
        const primeraVez = await this.redis.set(dedupeKey, '1', 'EX', ORDER_KEY_TTL_SECONDS, 'NX');
        if (!primeraVez) return false;

        let guardada: MarketplaceOrder | null = null;
        try {
            guardada = await this.orders.save(this.orders.create(this.datosDeVenta(connection, externalId, orden) as DeepPartial<MarketplaceOrder>));
        } catch (error: any) {
            console.warn(`[Sync] Venta ${externalId} de ${NOMBRES[canal]} no persistida: ${error?.message}`);
            // Si el fallo no es «ya existe», se libera la marca para reintentar en la próxima consulta.
            if (error?.code !== '23505') {
                await this.redis.del(dedupeKey);
                return false;
            }
        }
        // Una venta de antes de conectar la cuenta es historia: ni correo, ni aviso, ni stock.
        if (options.soloRegistro || ventaAnteriorALaConexion(connection, orden.orderDate)) return true;
        await this.aplicarEfectos(connection, externalId, orden, guardada);
        return true;
    }

    private datosDeVenta(connection: MarketplaceConnection, externalId: string, orden: ChannelOrder): any {
        const norm = orden.normalized;
        return {
            marketplace: connection.marketplace,
            externalId,
            owner: { id: connection.owner.id } as any,
            store: connection.store ? ({ id: connection.store.id } as any) : null,
            connection: { id: connection.id } as any,
            totalAmount: orden.totalAmount,
            productsAmount: importeDeProductos(norm.lines, orden.totalAmount),
            currency: resolverMoneda(orden.currency, connection.currency),
            itemsCount: norm.lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0) || 1,
            items: norm.lines as any,
            orderNumber: norm.orderNumber,
            customerName: norm.customerName,
            shipByDate: norm.shipByDate,
            details: norm.details as any,
            status: orden.channelStatus.slice(0, 30),
            ...(orden.saleState ? { saleState: orden.saleState } : {}),
            ...(norm.costs ?? {}),
            orderDate: orden.orderDate,
        };
    }

    /** Un pedido sin pago confirmado (o cancelado o fallido): queda a la vista en Ventas, sin tocar stock ni avisar. */
    private async guardarSinPago(connection: MarketplaceConnection, externalId: string, orden: ChannelOrder): Promise<boolean> {
        try {
            const datos = this.datosDeVenta(connection, externalId, orden);
            await this.orders.save(this.orders.create({ ...datos, details: { ...datos.details, noAplicada: true } } as DeepPartial<MarketplaceOrder>));
            return true;
        } catch (error: any) {
            if (error?.code !== '23505') console.warn(`[Sync] Pedido ${externalId} sin pagar no persistido: ${error?.message}`);
            return false;
        }
    }

    /** Un pedido que estaba guardado sin pago ya se pagó: ahora es una venta, con su aviso y su descuento de stock. */
    private async confirmarPago(
        connection: MarketplaceConnection,
        registrada: MarketplaceOrder,
        orden: ChannelOrder,
        options: { soloRegistro: boolean },
    ): Promise<boolean> {
        const anterior = ventaAnteriorALaConexion(connection, orden.orderDate);
        // El historial nunca mueve stock: una venta en curso la confirma la consulta periódica, que sí lo descuenta.
        if (options.soloRegistro && !anterior) return false;

        const dedupeKey = `${connection.marketplace}:order-applied:${connection.id}:${orden.externalId}`;
        const primeraVez = await this.redis.set(dedupeKey, '1', 'EX', ORDER_KEY_TTL_SECONDS, 'NX');
        if (!primeraVez) return false;

        const { owner, store, connection: cuenta, orderDate, externalId, marketplace, ...cambios } = this.datosDeVenta(connection, registrada.externalId, orden);
        try {
            await this.orders.update(registrada.id, cambios);
        } catch (error: any) {
            console.warn(`[Sync] Pago de ${registrada.externalId} no guardado: ${error?.message}`);
            await this.redis.del(dedupeKey);
            return false;
        }
        if (!anterior) await this.aplicarEfectos(connection, registrada.externalId, orden, { ...registrada, ...cambios } as MarketplaceOrder);
        return true;
    }

    /** El correo, los avisos y el descuento de stock de una venta recién confirmada. */
    private async aplicarEfectos(connection: MarketplaceConnection, externalId: string, orden: ChannelOrder, guardada: MarketplaceOrder | null): Promise<void> {
        const canal = connection.marketplace as EcommerceChannel;
        const userId = connection.owner.id;
        const norm = orden.normalized;
        if (guardada) void this.saleAlerts.notificar(guardada, NOMBRES[canal]);

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
    }

    /**
     * Pone al día una venta ya registrada con lo que dice el canal ahora: su estado, el número de seguimiento y el transportista.
     * Solo escribe si algo cambió (la consulta periódica repasa las últimas 48 horas en cada pasada). El stock solo se toca si la venta pasa a cancelada o devuelta (ver `reponerStockDeVenta`).
     */
    private async reflejarEstado(registrada: MarketplaceOrder, orden: ChannelOrder): Promise<void> {
        const det: any = registrada.details ?? null;
        const envio = orden.normalized.details.shipping;
        const rastreo = envio.trackingCode ?? det?.shipping?.trackingCode ?? null;
        const transportista = envio.carrier ?? det?.shipping?.carrier ?? null;
        const igual =
            registrada.status === orden.channelStatus.slice(0, 30) &&
            registrada.saleState === orden.saleState &&
            (det?.shipping?.status ?? null) === envio.status &&
            (det?.shipping?.trackingCode ?? null) === rastreo &&
            (det?.shipping?.carrier ?? null) === transportista;
        if (igual) return;
        const estadoAntes = registrada.saleState;
        await this.orders.update(registrada.id, {
            status: orden.channelStatus.slice(0, 30),
            saleState: orden.saleState,
            ...(det
                ? { details: { ...det, channelStatus: orden.channelStatus, shipping: { ...det.shipping, status: envio.status, trackingCode: rastreo, carrier: transportista } } as any }
                : {}),
        });
        // Cancelada o devuelta: lo que no había salido vuelve al stock; lo ya enviado queda por reponer hasta que llegue.
        await this.sync.reponerStockDeVenta(registrada.id, estadoAntes, orden.saleState);
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
