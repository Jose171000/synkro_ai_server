import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { MarketplaceConnection } from './entities/marketplace-connection.entity';
import { ListingLink } from './entities/listing-link.entity';
import { MarketplaceOrder } from './entities/marketplace-order.entity';
import { Product } from '../products/entities/product.entity';
import { MeliApiService, MeliItemPayload } from './meli/meli-api.service';
import { YavendioApiService } from './yavendio/yavendio-api.service';
import { FalabellaApiService, FalabellaCredentials, FalabellaProduct, imagenesDeFicha, preciosDeUnidad, unidadPrincipal } from './falabella/falabella-api.service';
import { chunkProducts, FalabellaProductInput } from './falabella/falabella-product-xml';
import { MarketplaceFeed } from './falabella/entities/marketplace-feed.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { FalabellaAttribute, FalabellaCategory } from './falabella/falabella-api.service';
import { UpdateInventoryDto } from './dto/update-inventory.dto';
import { ChangeRequestsService } from './change-requests.service';
import { StoresService } from '../stores/stores.service';
import { monedaDePais, monedaPorDefecto, resolverMoneda } from '../common/currency';

/**
 * Atributos obligatorios que ya se mandan como campos fijos del producto:
 * no hay que volver a pedirselos a quien carga el catalogo.
 */
const ATRIBUTOS_YA_CUBIERTOS = new Set([
    'name', 'brand', 'description', 'primary_category', 'seller_sku',
    'condition_type', 'package_width', 'package_length', 'package_height',
    'package_weight', 'variation', 'price', 'stock', 'status',
]);

/** Por debajo de estas unidades se avisa que un producto se agota. */
const LOW_STOCK_THRESHOLD = 5;

/** Cuántas cuentas del mismo canal admite una tienda. */
export const MAX_ACCOUNTS_PER_MARKETPLACE = 3;

/** Quién actúa y en qué tienda: todo lo que toca canales se hace dentro de una tienda. */
export interface SyncScope {
    userId: string;
    storeId: string;
}

const MARKETPLACE_NAMES: Record<string, string> = {
    mercadolibre: 'Mercado Libre',
    falabella: 'Falabella',
    yavendio: 'Yavendió',
};
const nombreCanal = (id: string) => MARKETPLACE_NAMES[id] ?? id;

const OAUTH_STATE_TTL_SECONDS = 600; // 10 min to complete the OAuth flow
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

@Injectable()
export class SyncService {
    constructor(
        @InjectRepository(MarketplaceConnection)
        private readonly connectionRepository: Repository<MarketplaceConnection>,
        @InjectRepository(ListingLink)
        private readonly listingLinkRepository: Repository<ListingLink>,
        @InjectRepository(MarketplaceOrder)
        private readonly orderRepository: Repository<MarketplaceOrder>,
        @InjectRepository(MarketplaceFeed)
        private readonly feedRepository: Repository<MarketplaceFeed>,
        @InjectRepository(Product)
        private readonly productRepository: Repository<Product>,
        @InjectQueue('marketplace-sync-queue')
        private readonly syncQueue: Queue,
        @Inject(REDIS_CLIENT)
        private readonly redis: Redis,
        private readonly meliApi: MeliApiService,
        private readonly yavendioApi: YavendioApiService,
        private readonly falabellaApi: FalabellaApiService,
        private readonly notifications: NotificationsService,
        private readonly changeRequests: ChangeRequestsService,
        private readonly stores: StoresService,
    ) { }

    // ─────────────────────────────────────────────────────────────
    // Cuentas de canales de una tienda
    // ─────────────────────────────────────────────────────────────

    /**
     * Busca la cuenta del canal que se está conectando o, si es nueva, la
     * prepara. Reconectar una cuenta que ya está en la tienda la actualiza;
     * una cuenta distinta del mismo canal cuenta para el límite.
     */
    private async findOrCreateConnection(
        scope: SyncScope,
        marketplace: string,
        externalUserId: string,
    ): Promise<MarketplaceConnection> {
        const existing = await this.connectionRepository.findOne({
            where: { marketplace, externalUserId, store: { id: scope.storeId } },
        });
        if (existing) return existing;

        const total = await this.connectionRepository.count({
            where: { marketplace, store: { id: scope.storeId } },
        });
        if (total >= MAX_ACCOUNTS_PER_MARKETPLACE) {
            throw new BadRequestException(
                `Una tienda admite hasta ${MAX_ACCOUNTS_PER_MARKETPLACE} cuentas de ${nombreCanal(marketplace)}. ` +
                `Desconecta una para poder agregar otra.`,
            );
        }
        return this.connectionRepository.create({
            marketplace,
            externalUserId,
            store: { id: scope.storeId } as any,
            owner: { id: scope.userId } as any,
        });
    }

    /**
     * Al conectar una cuenta nueva se recuperan las publicaciones que quedaron
     * sin cuenta cuando se desconectó una anterior del mismo canal, para no
     * perder el enlace con lo que ya estaba publicado.
     */
    private async readoptOrphanLinks(scope: SyncScope, marketplace: string, connectionId: string): Promise<void> {
        const huerfanas = await this.listingLinkRepository.find({
            where: { marketplace, connection: IsNull(), product: { store: { id: scope.storeId } } },
        });
        for (const link of huerfanas) {
            link.connection = { id: connectionId } as any;
            await this.listingLinkRepository.save(link);
        }
    }

    /** Las tres filas de una cuenta nueva o recién actualizada se guardan igual. */
    private async saveConnection(scope: SyncScope, connection: MarketplaceConnection, label?: string | null) {
        const isNew = !connection.id;
        if (label !== undefined && label !== null && label.trim()) connection.label = label.trim().slice(0, 60);
        const saved = await this.connectionRepository.save(connection);
        if (isNew) await this.readoptOrphanLinks(scope, saved.marketplace, saved.id);
        return saved;
    }

    // ─────────────────────────────────────────────────────────────
    // OAuth: connect a Mercado Libre seller account
    // ─────────────────────────────────────────────────────────────

    /**
     * Generates the Mercado Libre authorization URL. The random `state` is
     * stored in Redis mapped to the user AND the store, so the public callback
     * knows which store the new account belongs to (and rejects forged callbacks).
     */
    async getMeliAuthUrl(scope: SyncScope, label?: string): Promise<{ authUrl: string }> {
        this.meliApi.assertConfigured();
        const state = randomUUID();
        await this.redis.setex(
            `meli:oauth-state:${state}`,
            OAUTH_STATE_TTL_SECONDS,
            JSON.stringify({ userId: scope.userId, storeId: scope.storeId, label: label?.trim() || null }),
        );
        return { authUrl: this.meliApi.buildAuthUrl(state) };
    }

    /** Public callback: exchanges the code and persists the connection. */
    async handleMeliCallback(code: string, state: string): Promise<{ marketplace: string; nickname: string; storeId: string }> {
        if (!code || !state) {
            throw new BadRequestException('Faltan los parámetros code y state.');
        }

        const stateKey = `meli:oauth-state:${state}`;
        const raw = await this.redis.get(stateKey);
        if (!raw) {
            throw new BadRequestException('El state de OAuth es inválido o expiró. Vuelve a iniciar la conexión.');
        }
        await this.redis.del(stateKey);

        // Un state viejo guardaba solo el id del usuario: se acepta y se asigna
        // a su tienda por defecto, para no tirar conexiones a medio hacer.
        let parsed: { userId: string; storeId?: string; label?: string | null };
        try {
            parsed = JSON.parse(raw);
        } catch {
            parsed = { userId: raw };
        }
        const userId = parsed.userId;
        const storeId = parsed.storeId ?? (await this.stores.defaultStoreId(userId));
        if (!userId || !storeId) {
            throw new BadRequestException('No se pudo determinar la tienda de esta conexión.');
        }
        const scope: SyncScope = { userId, storeId };

        const tokens = await this.meliApi.exchangeCode(code);
        const profile = await this.meliApi.getMe(tokens.accessToken);

        // Upsert: reconnecting the same account overwrites its credentials
        const connection = await this.findOrCreateConnection(scope, 'mercadolibre', tokens.externalUserId);
        connection.externalNickname = profile.nickname;
        connection.accessToken = tokens.accessToken;
        connection.refreshToken = tokens.refreshToken;
        connection.expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);
        connection.status = 'active';

        await this.saveConnection(scope, connection, parsed.label);
        return { marketplace: 'mercadolibre', nickname: profile.nickname, storeId };
    }

    /** Cuentas conectadas de una tienda (sin credenciales). */
    async getConnections(storeId: string) {
        const connections = await this.connectionRepository.find({
            where: { store: { id: storeId } },
            order: { createdAt: 'ASC' },
        });
        // Never expose credentials to the frontend
        return connections.map(({ accessToken, refreshToken, secrets, ...safe }) => safe);
    }

    /**
     * Desconecta una cuenta. Se acepta el id de la cuenta o, por compatibilidad,
     * el nombre del canal cuando la tienda solo tiene una de ese canal.
     */
    async disconnect(storeId: string, ref: string) {
        const porId = /^[0-9a-f-]{36}$/i.test(ref);
        let connection: MarketplaceConnection | null = null;

        if (porId) {
            connection = await this.connectionRepository.findOne({ where: { id: ref, store: { id: storeId } } });
        } else {
            const todas = await this.connectionRepository.find({ where: { marketplace: ref, store: { id: storeId } } });
            if (todas.length > 1) {
                throw new BadRequestException(
                    `Esta tienda tiene ${todas.length} cuentas de ${nombreCanal(ref)}. Indica cuál desconectar.`,
                );
            }
            connection = todas[0] ?? null;
        }
        if (!connection) {
            throw new NotFoundException('No hay una cuenta conectada con ese nombre en esta tienda.');
        }
        await this.connectionRepository.remove(connection);
        return { message: `Cuenta de ${nombreCanal(connection.marketplace)} desconectada.` };
    }

    /**
     * La cuenta a usar para un canal dentro de una tienda. Si se indica cuál,
     * se valida que sea de la tienda; si no, solo vale cuando hay una sola:
     * con varias, adivinar podría publicar en la cuenta equivocada.
     */
    async resolveConnection(storeId: string, marketplace: string, connectionId?: string): Promise<MarketplaceConnection> {
        if (connectionId) {
            const found = await this.connectionRepository.findOne({
                where: { id: connectionId, marketplace, store: { id: storeId } },
                select: { id: true },
            });
            if (!found) throw new NotFoundException(`Esa cuenta de ${nombreCanal(marketplace)} no pertenece a esta tienda.`);
            return this.getValidConnectionById(found.id);
        }

        const todas = await this.connectionRepository.find({
            where: { marketplace, store: { id: storeId }, status: 'active' },
            select: { id: true },
            order: { createdAt: 'ASC' },
        });
        if (todas.length === 0) {
            throw new BadRequestException(
                `Esta tienda no tiene una cuenta de ${nombreCanal(marketplace)} conectada. Ve a Marketplaces y conéctala primero.`,
            );
        }
        if (todas.length > 1) {
            throw new BadRequestException(
                `Esta tienda tiene ${todas.length} cuentas de ${nombreCanal(marketplace)} conectadas. Indica cuál usar.`,
            );
        }
        return this.getValidConnectionById(todas[0].id);
    }

    /**
     * Para flujos que aún llegan sin tienda (el CRM de Yavendió, jobs encolados
     * antes de este cambio): la primera cuenta activa del usuario en el canal.
     */
    private async getValidConnection(userId: string, marketplace: string): Promise<MarketplaceConnection> {
        const first = await this.connectionRepository.findOne({
            where: { marketplace, owner: { id: userId }, status: 'active' },
            select: { id: true },
            order: { createdAt: 'ASC' },
        });
        if (!first) {
            throw new BadRequestException(
                `No tienes una cuenta de ${nombreCanal(marketplace)} conectada. Ve a Marketplaces y conéctala primero.`,
            );
        }
        return this.getValidConnectionById(first.id);
    }

    /**
     * Returns the connection with a valid access token,
     * refreshing it transparently if it is about to expire.
     */
    private async getValidConnectionById(connectionId: string): Promise<MarketplaceConnection> {
        const connection = await this.connectionRepository.findOne({
            where: { id: connectionId, status: 'active' },
            relations: { owner: true, store: true },
        });
        if (!connection) {
            throw new BadRequestException('Esa cuenta ya no está conectada. Ve a Marketplaces y conéctala de nuevo.');
        }
        const marketplace = connection.marketplace;
        const nombre = nombreCanal(marketplace);
        const notifyUserId = connection.owner.id;

        // Si la credencial no se pudo descifrar (clave cambiada o fila alterada)
        // llega como null: se marca la conexión como rota y se pide reconectar,
        // en lugar de intentar llamar a la API con un token vacío.
        if (!connection.accessToken) {
            // update() y no save(): guardar la entidad completa reescribiría
            // el token ilegible como NULL y perderíamos el dato cifrado.
            await this.connectionRepository.update(connection.id, { status: 'error' });
            await this.notifications.notify(notifyUserId, {
                type: 'connection',
                severity: 'error',
                title: `No se pueden leer las credenciales de ${nombre}`,
                body: 'Vuelve a conectar la cuenta desde Marketplaces para seguir publicando y recibiendo ventas.',
                marketplace,
            });
            throw new BadRequestException(
                `No se pudieron leer las credenciales guardadas de ${nombre}. Reconecta tu cuenta.`,
            );
        }

        // Solo Mercado Libre usa OAuth con tokens que caducan. Las API keys
        // (Yavendió, Falabella) no tienen expiración ni refresco: viven hasta
        // que el cliente las revoca, y por eso expiresAt puede venir vacío.
        const needsRefresh =
            marketplace === 'mercadolibre' &&
            !!connection.expiresAt &&
            connection.expiresAt.getTime() - Date.now() < TOKEN_REFRESH_MARGIN_MS;
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
                await this.notifications.notify(notifyUserId, {
                    type: 'connection',
                    severity: 'error',
                    title: `Se cayó la conexión con ${nombre}`,
                    body:
                        `La sesión caducó y no se pudo renovar sola. Hasta que la reconectes, ` +
                        `no se publican productos ni se registran sus ventas.`,
                    marketplace,
                });
                throw new BadRequestException(
                    `La sesión con ${nombre} expiró y no se pudo renovar. Reconecta tu cuenta.`,
                );
            }
        }

        return connection;
    }

    // ─────────────────────────────────────────────────────────────
    // Yavendió: conexión por API key
    // ─────────────────────────────────────────────────────────────

    /**
     * Conecta una cuenta de Yavendió a la tienda a partir de una API key que
     * el usuario pega. A diferencia de Mercado Libre no hay OAuth: la clave ES
     * la credencial, así que antes de guardarla se comprueba contra la API
     * pidiendo el perfil de la empresa. Así el usuario sabe al instante si
     * la clave sirve, y de paso vemos a qué cuenta pertenece.
     *
     * La clave nunca vuelve al frontend y se guarda cifrada.
     */
    async connectYavendio(
        scope: SyncScope,
        apiKey: string,
        label?: string,
    ): Promise<{ id: string; marketplace: string; nickname: string }> {
        const trimmed = (apiKey || '').trim();
        if (!trimmed) {
            throw new BadRequestException('Pega la API key de Yavendió para conectar la cuenta.');
        }

        // Si la clave no sirve, esto lanza un error explicando por qué y no
        // llegamos a guardar nada.
        const company = await this.yavendioApi.getCompany(trimmed);

        const connection = await this.findOrCreateConnection(scope, 'yavendio', String(company.id));
        connection.externalNickname = company.name;
        connection.accessToken = trimmed;
        connection.refreshToken = null as any;
        connection.expiresAt = null; // las API keys no caducan
        connection.secrets = {
            country: company.country,
            currency: company.currency,
            plan: company.planName,
            phoneNumber: company.phoneNumber,
        };
        connection.status = 'active';

        const saved = await this.saveConnection(scope, connection, label);
        return { id: saved.id, marketplace: 'yavendio', nickname: company.name };
    }

    /**
     * Devuelve la API key descifrada de Yavendió del usuario. La usa el CRM
     * para traer las conversaciones. Es interna: ningún endpoint la expone.
     */
    async getYavendioApiKey(userId: string): Promise<string> {
        const connection = await this.getValidConnection(userId, 'yavendio');
        return connection.accessToken;
    }

    // ─────────────────────────────────────────────────────────────
    // Falabella: conexión por UserID + API key
    // ─────────────────────────────────────────────────────────────

    /**
     * Conecta una cuenta del Seller Center de Falabella a la tienda. Necesita
     * dos datos: el UserID (que es el correo de la cuenta) y la API key. Los
     * dos viajan en cada petición —el correo como parámetro y la clave como
     * secreto que firma la llamada— así que el correo se guarda legible y la
     * clave cifrada.
     *
     * Antes de guardar nada se hace una consulta real: si la firma o la clave
     * están mal, Falabella rechaza todo por igual y es mejor que el usuario se
     * entere aquí y no cuando intente publicar.
     */
    async connectFalabella(
        scope: SyncScope,
        credentials: FalabellaCredentials & { country?: string; label?: string },
    ): Promise<{ id: string; marketplace: string; nickname: string; currency: string }> {
        const userId = (credentials.userId || '').trim();
        const apiKey = (credentials.apiKey || '').trim();
        if (!userId || !apiKey) {
            throw new BadRequestException('Falta el UserID o la API key de Falabella.');
        }

        await this.falabellaApi.verifyCredentials({ userId, apiKey });

        const connection = await this.findOrCreateConnection(scope, 'falabella', userId);
        connection.externalNickname = userId;
        connection.accessToken = apiKey;
        connection.refreshToken = null as any;
        connection.expiresAt = null; // las API keys no caducan
        connection.status = 'active';

        // Falabella usa la misma API para Perú, Chile y Colombia, así que el
        // país no se puede deducir de la credencial: se pregunta al conectar.
        // Si no viene, se conserva lo que ya hubiera antes de sobrescribir.
        connection.currency =
            monedaDePais(credentials.country) ?? connection.currency ?? monedaPorDefecto();

        const saved = await this.saveConnection(scope, connection, credentials.label);
        return { id: saved.id, marketplace: 'falabella', nickname: userId, currency: saved.currency ?? monedaPorDefecto() };
    }

    /**
     * Moneda guardada para una cuenta.
     * Devuelve `undefined` si no se guardó, para que quien llame decida.
     */
    private async monedaDeCuenta(connectionId: string): Promise<string | undefined> {
        const connection = await this.connectionRepository.findOne({
            where: { id: connectionId },
            select: { id: true, currency: true },
        });
        return connection?.currency ?? undefined;
    }

    private credentialsOf(connection: MarketplaceConnection): FalabellaCredentials {
        return { userId: connection.externalUserId, apiKey: connection.accessToken };
    }

    /**
     * Producto de la tienda por su SKU. Si el SKU existe pero pertenece a otra
     * tienda del mismo dueño, se avisa en vez de pisarlo: dos tiendas no
     * comparten el stock de un producto.
     */
    private async findProductBySku(
        scope: SyncScope,
        sku: string,
    ): Promise<{ product: Product | null; otraTienda: boolean }> {
        const found = await this.productRepository.findOne({
            where: [
                { sku, store: { id: scope.storeId } },
                { sku, owner: { id: scope.userId } },
            ],
            relations: { store: true },
        });
        if (!found) return { product: null, otraTienda: false };
        if (found.store && found.store.id !== scope.storeId) return { product: null, otraTienda: true };
        if (!found.store) {
            await this.productRepository.update(found.id, { store: { id: scope.storeId } } as any);
            found.store = { id: scope.storeId } as any;
        }
        return { product: found, otraTienda: false };
    }

    /** Credenciales descifradas de una cuenta de Falabella. Interna: ningún endpoint las expone. */
    async getFalabellaCredentials(connectionId: string): Promise<FalabellaCredentials> {
        const connection = await this.getValidConnectionById(connectionId);
        return { userId: connection.externalUserId, apiKey: connection.accessToken };
    }

    /**
     * Producto de la tienda por su id. Un producto sin tienda asignada (de
     * antes de este cambio) se acepta si es del usuario y se adopta: pasa a
     * la tienda desde la que se usa.
     */
    private async findScopedProduct(scope: SyncScope, productId: string): Promise<Product> {
        const product = await this.productRepository.findOne({
            where: [
                { id: productId, store: { id: scope.storeId } },
                { id: productId, store: IsNull(), owner: { id: scope.userId } },
            ],
            relations: { store: true },
        });
        if (!product) throw new NotFoundException('Producto no encontrado');
        if (!product.store) {
            await this.productRepository.update(product.id, { store: { id: scope.storeId } } as any);
            product.store = { id: scope.storeId } as any;
        }
        return product;
    }

    // ─────────────────────────────────────────────────────────────
    // Falabella: traer las publicaciones que ya existen
    // ─────────────────────────────────────────────────────────────

    /**
     * Cómo se traduce el estado de una ficha de Falabella al nuestro.
     *
     * El control de calidad manda sobre el estado: una ficha «activa» pero
     * rechazada por QC no se ve en la tienda, y mostrarla como publicada sería
     * justo el tipo de mentira que este módulo viene a quitar.
     */
    private estadoDeFicha(producto: FalabellaProduct): ListingLink['syncStatus'] {
        // El control de calidad manda: una ficha rechazada no la ve nadie,
        // por mucho que su unidad de negocio diga que está activa.
        const qc = String(producto.QCStatus ?? '').trim().toLowerCase();
        if (qc === 'rejected') return 'error';

        const unidad = unidadPrincipal(producto);
        const estado = String(unidad.Status ?? '').trim().toLowerCase();

        if (estado === 'inactive' || estado === 'deleted') return 'paused';

        // Activa pero sin publicar es el limbo de siempre: aprobada y todavía
        // no visible en la tienda. Mostrarla como publicada sería mentir.
        if (estado === 'active') {
            return String(unidad.IsPublished ?? '') === '1' ? 'published' : 'pending';
        }

        return 'pending';
    }

    /**
     * Nota de calidad de la ficha, de 0 a 100, según Falabella.
     * Es la medida de optimización que hasta ahora se llevaba a mano.
     */
    private notaDeFicha(producto: FalabellaProduct): number | null {
        const nota = Number(producto.ContentScore);
        if (!Number.isFinite(nota)) return null;
        return Math.max(0, Math.min(100, Math.round(nota)));
    }

    /**
     * Trae de un tirón todas las publicaciones que el vendedor ya tiene en
     * Falabella y las enlaza con el catálogo de Synkro.
     *
     * Es la alternativa a que el cliente rellene una hoja a mano: si tiene la
     * cuenta conectada, en un clic sabemos qué está publicado de verdad y en
     * qué estado, sin depender de nadie.
     *
     * Con `dryRun` no escribe nada: solo cuenta qué pasaría. Se usa para
     * enseñar la previsualización antes de tocar el catálogo, porque un
     * vendedor con cientos de fichas no espera que le aparezcan cientos de
     * productos nuevos sin avisar.
     */
    async importFalabellaListings(
        scope: SyncScope,
        connectionId: string | undefined,
        options: { dryRun?: boolean } = {},
    ) {
        const userId = scope.userId;
        const connection = await this.resolveConnection(scope.storeId, 'falabella', connectionId);
        const credentials = this.credentialsOf(connection);
        const { productos, incompleto } = await this.falabellaApi.getAllProducts(credentials);

        let sumaNotas = 0;
        let conNota = 0;

        const resumen = {
            total: productos.length,
            yaEnCatalogo: 0,
            nuevas: 0,
            enlazadas: 0,
            /** Fichas cuyo SKU ya existe en otra tienda tuya: no se tocan. */
            enOtraTienda: 0,
            incompleto,
            porEstado: {} as Record<string, number>,
            /** Media de la nota de calidad que pone Falabella. */
            notaMedia: null as number | null,
            ejemplos: [] as {
                sku: string; nombre: string; estado: string;
                nota: number | null; enCatalogo: boolean;
            }[],
        };

        for (const producto of productos) {
            const sku = String(producto.SellerSku ?? '').trim();
            if (!sku) continue;

            const estado = this.estadoDeFicha(producto);
            const nota = this.notaDeFicha(producto);
            resumen.porEstado[estado] = (resumen.porEstado[estado] ?? 0) + 1;
            if (nota !== null) { sumaNotas += nota; conNota++; }

            const encontrado = await this.findProductBySku(scope, sku);
            if (encontrado.otraTienda) {
                resumen.enOtraTienda++;
                continue;
            }
            let product = encontrado.product;
            const estabaEnCatalogo = !!product;

            if (estabaEnCatalogo) resumen.yaEnCatalogo++;
            else resumen.nuevas++;

            if (resumen.ejemplos.length < 10) {
                resumen.ejemplos.push({
                    sku,
                    nombre: String(producto.Name ?? '').slice(0, 80),
                    estado,
                    nota,
                    enCatalogo: estabaEnCatalogo,
                });
            }

            if (options.dryRun) continue;

            // Precio y stock viven dentro de la unidad de negocio, no en la
            // raíz. Falabella los manda como texto; un catálogo sin precio es
            // válido, así que "sin precio" se guarda vacío y no como cero,
            // que se leería como producto regalado.
            //
            // El precio de Synkro es el REGULAR: es el que se manda de vuelta a
            // Falabella al editar, y ahí el descuento (SpecialPrice) es otro
            // campo. Si Synkro guardara el precio rebajado como suyo, el
            // siguiente envío dejaría el regular igual o por debajo de la
            // promoción.
            const unidad = unidadPrincipal(producto);
            const { regular: precio, descuento } = preciosDeUnidad(unidad);
            const existencias = Number(unidad.Stock ?? 0) || 0;
            const imagenes = imagenesDeFicha(producto);

            // El producto que aún no tenemos se crea con lo poco que Falabella
            // devuelve, y queda como borrador: es un registro de que la ficha
            // existe, no un producto listo para publicar en otros canales.
            if (!product) {
                const nuevo = this.productRepository.create({
                    sku,
                    name: String(producto.Name ?? sku).slice(0, 250),
                    description: '',
                    price: precio ?? undefined,
                    stock: existencias,
                    status: 'draft',
                    owner: { id: userId } as any,
                    store: { id: scope.storeId } as any,
                    // Cada variante es su propio SKU en Falabella, con su imagen.
                    images: imagenes.map(url => ({ url })) as any,
                });
                product = await this.productRepository.save(nuevo);
            }

            const externalId = String(producto.ShopSku ?? sku);

            let enlace = await this.listingLinkRepository.findOne({
                where: { product: { id: product.id }, connection: { id: connection.id } },
            });
            if (!enlace) {
                enlace = this.listingLinkRepository.create({
                    marketplace: 'falabella',
                    product: { id: product.id } as any,
                    connection: { id: connection.id } as any,
                });
            }

            // Un producto que ya existía y nunca se tocó desde la última
            // sincronización guardaba el precio rebajado (así importaba antes):
            // se corrige al regular. Si el usuario lo editó, no se pisa.
            if (
                estabaEnCatalogo && precio !== null && descuento !== null &&
                enlace.lastPriceSynced != null &&
                Number(product.price) === Number(enlace.lastPriceSynced) &&
                Number(product.price) !== precio
            ) {
                product.price = precio as any;
                await this.productRepository.save(product);
            }

            enlace.externalId = externalId;
            enlace.permalink = producto.Url ?? enlace.permalink ?? null as any;
            enlace.syncStatus = estado;
            enlace.lastStockSynced = existencias;
            enlace.lastPriceSynced = precio as any;
            enlace.regularPrice = precio;
            enlace.salePrice = descuento;
            enlace.imageUrl = imagenes[0] ?? null;
            enlace.variation = producto.Variation ? String(producto.Variation).slice(0, 200) : null;
            enlace.parentSku = producto.ParentSku ? String(producto.ParentSku).slice(0, 200) : null;
            enlace.qualityScore = nota;
            enlace.lastSyncedAt = new Date();
            enlace.lastError = estado === 'error'
                ? 'Falabella rechazó la ficha en su control de calidad.'
                : null as any;

            await this.listingLinkRepository.save(enlace);
            resumen.enlazadas++;
        }

        resumen.notaMedia = conNota > 0 ? Math.round(sumaNotas / conNota) : null;

        if (!options.dryRun && resumen.enlazadas > 0) {
            await this.notifications.notify(userId, {
                type: 'import',
                severity: incompleto ? 'warning' : 'success',
                title: `Falabella: ${resumen.enlazadas} publicaciones importadas`,
                body:
                    `${resumen.yaEnCatalogo} ya estaban en tu catálogo y ${resumen.nuevas} se ` +
                    `crearon como borrador.` +
                    (incompleto ? ' El catálogo es muy grande y quedaron fichas sin leer.' : ''),
                marketplace: 'falabella',
                meta: { total: resumen.total, porEstado: resumen.porEstado },
            });
        }

        return resumen;
    }

    // ─────────────────────────────────────────────────────────────
    // Publishing
    // ─────────────────────────────────────────────────────────────

    /** Enqueues one publish job per marketplace and returns immediately. */
    async enqueuePublish(
        scope: SyncScope,
        productId: string,
        marketplaces: string[],
        connectionIds: Record<string, string> = {},
    ) {
        const product = await this.findScopedProduct(scope, productId);
        if (product.price === null || product.price === undefined) {
            throw new BadRequestException('El producto necesita un precio antes de publicarse.');
        }

        for (const marketplace of marketplaces) {
            // Validate the connection now so the user gets an immediate error
            const connection = await this.resolveConnection(scope.storeId, marketplace, connectionIds[marketplace]);
            await this.syncQueue.add('publish', {
                productId,
                userId: scope.userId,
                storeId: scope.storeId,
                marketplace,
                connectionId: connection.id,
            });
        }

        return {
            message: `Publicación encolada en: ${marketplaces.join(', ')}. Recibirás el estado en /sync/products/${productId}/status.`,
        };
    }

    /** Executed by the queue processor: actually publishes on Mercado Libre. */
    async publishToMeli(productId: string, userId: string, connectionId: string): Promise<ListingLink> {
        const product = await this.productRepository.findOne({ where: { id: productId } });
        if (!product) {
            throw new NotFoundException('Producto no encontrado');
        }

        let link = await this.listingLinkRepository.findOne({
            where: { product: { id: productId }, connection: { id: connectionId } },
        });
        if (link?.syncStatus === 'published') {
            return link; // already live — inventory updates go through syncInventory
        }
        if (!link) {
            link = this.listingLinkRepository.create({
                marketplace: 'mercadolibre',
                externalId: '',
                product,
                connection: { id: connectionId } as any,
                syncStatus: 'pending',
            });
        }

        try {
            const connection = await this.getValidConnectionById(connectionId);
            const categoryId = await this.resolveMeliCategory(product, connection.accessToken);
            const payload = this.buildMeliItemPayload(product, categoryId);
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
            await this.notifications.notify(userId, {
                type: 'publish-error',
                severity: 'error',
                title: `No se pudo publicar ${product.name} en Mercado Libre`,
                body: link.lastError,
                marketplace: 'mercadolibre',
                meta: { productId, sku: product.sku },
            });
            throw error;
        }

        await this.notifications.notify(userId, {
            type: 'publish',
            severity: 'success',
            title: `${product.name} ya está publicado en Mercado Libre`,
            body: `Publicación ${link.externalId} activa con ${product.stock} unidades.`,
            marketplace: 'mercadolibre',
            meta: { productId, sku: product.sku, permalink: link.permalink },
        });

        return this.listingLinkRepository.save(link);
    }

    /**
     * Resolves a REAL category id for the configured site (e.g. MPE for Perú).
     * Prefers the one stored by AI Phase A; if it's missing or belongs to
     * another site (e.g. demo seeds with MLA ids), falls back to Mercado
     * Libre's official category predictor based on the listing title.
     */
    private async resolveMeliCategory(product: Product, accessToken: string): Promise<string> {
        const site = process.env.MELI_SITE_ID || 'MPE';
        const stored: string | undefined =
            (product.marketplaceIds as any)?.mercadolibre_category_id ||
            (product.aiAttributes as any)?.mercadolibre_category_id;

        if (stored && stored.startsWith(site)) {
            return stored;
        }

        const title = (product.aiTitle || product.name).slice(0, 60);
        const predicted = await this.meliApi.predictCategory(accessToken, title);
        if (!predicted) {
            throw new BadRequestException(
                'No se pudo determinar la categoría de Mercado Libre para este producto. Revisa el título o asigna la categoría manualmente.',
            );
        }
        return predicted;
    }

    /**
     * Maps an internal product (+ its AI-generated content) to the payload
     * Mercado Libre expects.
     */
    private buildMeliItemPayload(product: Product, categoryId: string): MeliItemPayload {
        // ML builds the final title from family_name + attributes (max 60 chars)
        const familyName = (product.aiTitle || product.name).slice(0, 60);

        // BRAND and MODEL are the minimum attributes ML needs to build the title
        const brand = (product.aiAttributes as any)?.brand || 'Genérica';

        return {
            family_name: familyName,
            category_id: categoryId,
            price: Number(product.price),
            currency_id: process.env.MELI_CURRENCY_ID || monedaPorDefecto(),
            available_quantity: product.stock,
            condition: 'new',
            listing_type_id: process.env.MELI_LISTING_TYPE_ID || 'gold_special',
            pictures: (product.images || []).map(img => ({ source: img.url })),
            attributes: [
                { id: 'BRAND', value_name: brand },
                { id: 'MODEL', value_name: product.sku },
            ],
        };
    }

    // ─────────────────────────────────────────────────────────────
    // Falabella: publicación por lotes
    // ─────────────────────────────────────────────────────────────

    /** Categorías de Falabella donde se puede publicar, filtradas por texto. */
    async searchFalabellaCategories(scope: SyncScope, term: string, connectionId?: string): Promise<FalabellaCategory[]> {
        const connection = await this.resolveConnection(scope.storeId, 'falabella', connectionId);
        return this.falabellaApi.searchCategories(this.credentialsOf(connection), term);
    }

    /**
     * Datos que pide una categoría, para poder dibujar el formulario:
     * cuáles son obligatorios, cómo se llaman en castellano y qué valores
     * admiten. Se marcan los que la plataforma ya cubre por su cuenta.
     */
    async getFalabellaCategoryFields(scope: SyncScope, categoryId: string, connectionId?: string) {
        const connection = await this.resolveConnection(scope.storeId, 'falabella', connectionId);
        const attributes = await this.falabellaApi.getCategoryAttributes(this.credentialsOf(connection), categoryId);

        return attributes
            .filter(a => a.isMandatory && !ATRIBUTOS_YA_CUBIERTOS.has(a.name))
            .map(a => ({
                name: a.name,
                label: a.label || a.name,
                inputType: a.inputType,
                options: a.options,
            }));
    }

    /**
     * Guarda en un producto lo que Falabella exige y el sistema no puede
     * deducir solo: la categoría, las medidas del paquete y los atributos
     * propios de esa categoría.
     *
     * Va por su propio endpoint y no por la edición normal del producto
     * porque son datos de un canal concreto; mezclarlos con los campos
     * generales obligaría a que todo producto los conociera.
     */
    async prepareFalabellaProduct(
        scope: SyncScope,
        productId: string,
        datos: {
            categoryId: string;
            packageWidth: number;
            packageLength: number;
            packageHeight: number;
            packageWeight: number;
            attributes?: Record<string, string>;
        },
    ) {
        const product = await this.findScopedProduct(scope, productId);

        product.packageWidth = datos.packageWidth;
        product.packageLength = datos.packageLength;
        product.packageHeight = datos.packageHeight;
        product.packageWeight = datos.packageWeight;
        product.marketplaceIds = {
            ...((product.marketplaceIds as any) || {}),
            falabella_category_id: datos.categoryId,
        };
        // Se conservan los atributos que ya tuviera: la IA pudo generar
        // algunos y no hay por qué perderlos al completar los de Falabella.
        product.aiAttributes = {
            ...((product.aiAttributes as any) || {}),
            ...(datos.attributes || {}),
        };

        await this.productRepository.save(product);

        // Se comprueba con las reglas reales de publicación: así el usuario
        // sabe en el momento si el producto ya puede salir o le falta algo.
        const credentials = await this.resolveConnection(scope.storeId, 'falabella')
            .then(c => this.credentialsOf(c))
            .catch(() => null);
        let listo = true;
        let motivo: string | undefined;
        if (credentials) {
            const attrs = await this.falabellaApi
                .getCategoryAttributes(credentials, datos.categoryId)
                .catch(() => []);
            const resultado = this.toFalabellaInput(product, 'active', attrs);
            if ('reason' in resultado) {
                listo = false;
                motivo = resultado.reason;
            }
        }

        return {
            message: listo
                ? 'Producto listo para publicar en Falabella.'
                : `Guardado, pero todavía ${motivo}.`,
            listo,
            motivo,
        };
    }

    /** La categoría de Falabella asignada al producto, si la tiene. */
    private categoriaFalabella(product: Product): string | number | undefined {
        const marketplaceIds = (product.marketplaceIds as any) || {};
        const attributes = (product.aiAttributes as any) || {};
        return marketplaceIds.falabella_category_id ?? attributes.falabella_category_id;
    }

    /** Código de operador: identifica el país. 'fape' es Perú, 'facl' Chile. */
    private get falabellaOperatorCode(): string {
        return process.env.FALABELLA_OPERATOR_CODE || 'fape';
    }

    /**
     * Traduce un producto interno al formato de Falabella, o explica por qué
     * no se puede publicar.
     *
     * Se comprueba antes de enviar y no después porque para el usuario el
     * lote es una sola acción: es mejor decirle "a estos 3 productos les
     * faltan las medidas" que mandar 500 y devolverle errores sueltos
     * imposibles de interpretar.
     */
    private toFalabellaInput(
        product: Product,
        status: 'active' | 'inactive' = 'active',
        categoryAttributes: FalabellaAttribute[] = [],
    ): { input: FalabellaProductInput } | { reason: string } {
        const attributes = (product.aiAttributes as any) || {};
        const marketplaceIds = (product.marketplaceIds as any) || {};

        if (product.price === null || product.price === undefined) {
            return { reason: 'no tiene precio' };
        }

        const category = marketplaceIds.falabella_category_id ?? attributes.falabella_category_id;
        if (!category) {
            return { reason: 'no tiene categoría de Falabella asignada' };
        }

        // Falabella usa estas medidas para calcular el envío que paga el
        // comprador. Inventarlas tendría consecuencias reales, así que si
        // faltan el producto no se envía.
        const width = product.packageWidth ?? attributes.packageWidth;
        const length = product.packageLength ?? attributes.packageLength;
        const height = product.packageHeight ?? attributes.packageHeight;
        const weight = product.packageWeight ?? attributes.packageWeight;
        if (!width || !length || !height || !weight) {
            return { reason: 'le faltan las medidas o el peso del paquete' };
        }

        const description = product.aiDescription || product.description;
        if (!description || description.trim().length < 6) {
            return { reason: 'la descripción es demasiado corta (Falabella pide 6 caracteres como mínimo)' };
        }

        // Cada categoria exige atributos propios. Los que ya cubrimos con
        // campos fijos no se piden otra vez; del resto, si falta alguno
        // obligatorio se dice cual, en lugar de mandar el lote y que
        // Falabella lo rechace despues sin que nadie entienda por que.
        const faltantes: string[] = [];
        const propios: Record<string, string> = {};

        for (const attribute of categoryAttributes) {
            if (!attribute.isMandatory) continue;
            if (ATRIBUTOS_YA_CUBIERTOS.has(attribute.name)) continue;

            const valor = this.buscarAtributo(attributes, attribute.name);
            if (valor === undefined || valor === null || String(valor).trim() === '') {
                faltantes.push(attribute.label || attribute.feedName);
                continue;
            }
            // FeedName ya viene con el nombre exacto de la etiqueta XML.
            propios[attribute.feedName] = String(valor);
        }

        if (faltantes.length) {
            return { reason: `le faltan datos que pide su categoria en Falabella: ${faltantes.join(', ')}` };
        }

        return {
            input: {
                sellerSku: product.sku,
                name: (product.aiTitle || product.name).slice(0, 200),
                description,
                brand: attributes.brand || 'GENERICO',
                primaryCategory: category,
                price: Number(product.price),
                stock: product.stock,
                status,
                packageWidth: Number(width),
                packageLength: Number(length),
                packageHeight: Number(height),
                packageWeight: Number(weight),
                productId: attributes.ean || attributes.gtin || undefined,
                // Muchas categorias exigen Variation aunque el producto no
                // tenga variantes; el SKU sirve como valor unico.
                variation: attributes.variation || product.sku,
                extraAttributes: propios,
            },
        };
    }

    /**
     * Busca el valor de un atributo tolerando como este escrito: Falabella
     * los nombra `tipo_automotriz` y quien carga el producto puede haberlo
     * guardado como `tipoAutomotriz` o `TipoAutomotriz`.
     */
    private buscarAtributo(attributes: Record<string, any>, feedName: string): any {
        const normalizar = (texto: string) => texto.toLowerCase().replace(/[^a-z0-9]/g, '');
        const buscado = normalizar(feedName);
        for (const [clave, valor] of Object.entries(attributes || {})) {
            if (normalizar(clave) === buscado) return valor;
        }
        return undefined;
    }

    /**
     * Publica varios productos en Falabella en el menor número de llamadas
     * posible.
     *
     * Falabella admite 50 llamadas seguidas a las acciones de feed y después
     * exige 2 minutos entre cada una, así que mandar un producto por llamada
     * deja de ser viable en cuanto hay catálogo. Aquí se agrupan de a 500,
     * que es lo que ellos recomiendan.
     *
     * Con `status: 'inactive'` el producto se crea en Falabella pero no queda
     * a la venta: útil para revisarlo antes de exponerlo, o para probar la
     * integración sin poner nada en el escaparate.
     */
    async publishBatchToFalabella(
        scope: SyncScope,
        connectionId: string | undefined,
        productIds: string[],
        options: { status?: 'active' | 'inactive' } = {},
    ) {
        if (!productIds?.length) {
            throw new BadRequestException('Selecciona al menos un producto para publicar.');
        }

        const userId = scope.userId;
        const connection = await this.resolveConnection(scope.storeId, 'falabella', connectionId);
        const credentials = this.credentialsOf(connection);

        const products = await this.productRepository.find({
            where: productIds.flatMap(id => [
                { id, store: { id: scope.storeId } },
                { id, store: IsNull(), owner: { id: userId } },
            ]) as any,
            relations: { store: true },
        });
        if (!products.length) {
            throw new NotFoundException('No se encontraron productos que publicar.');
        }
        // Los productos de antes de las tiendas pasan a la tienda desde la que se publican.
        for (const p of products) {
            if (!p.store) {
                await this.productRepository.update(p.id, { store: { id: scope.storeId } } as any);
                p.store = { id: scope.storeId } as any;
            }
        }

        const aceptados: { product: Product; input: FalabellaProductInput }[] = [];
        const rechazados: { sku: string; nombre: string; motivo: string }[] = [];

        // Se consultan los atributos de cada categoria una sola vez, por mas
        // productos que la compartan.
        const atributosPorCategoria = new Map<string, FalabellaAttribute[]>();
        for (const product of products) {
            const categoria = this.categoriaFalabella(product);
            if (!categoria || atributosPorCategoria.has(String(categoria))) continue;
            try {
                atributosPorCategoria.set(
                    String(categoria),
                    await this.falabellaApi.getCategoryAttributes(credentials, categoria),
                );
            } catch (error: any) {
                // Si no se pueden consultar, seguimos con las validaciones
                // basicas: es peor bloquear la publicacion entera.
                console.warn(`[Sync] No se pudieron leer los atributos de la categoria ${categoria}: ${error?.message}`);
            }
        }

        for (const product of products) {
            const categoria = this.categoriaFalabella(product);
            const resultado = this.toFalabellaInput(
                product,
                options.status ?? 'active',
                atributosPorCategoria.get(String(categoria)) ?? [],
            );
            if ('reason' in resultado) {
                rechazados.push({ sku: product.sku, nombre: product.name, motivo: resultado.reason });
            } else {
                aceptados.push({ product, input: resultado.input });
            }
        }

        if (!aceptados.length) {
            return {
                message: 'Ningún producto cumple los requisitos de Falabella.',
                enviados: 0,
                rechazados,
                lotes: [],
            };
        }

        const lotes: { feedId: string; productos: number }[] = [];

        for (const lote of chunkProducts(aceptados, 500)) {
            const feedId = await this.falabellaApi.productCreate(
                credentials,
                lote.map(x => x.input),
                this.falabellaOperatorCode,
            );

            const feed = await this.feedRepository.save(this.feedRepository.create({
                marketplace: 'falabella',
                externalFeedId: feedId,
                action: 'ProductCreate',
                skus: lote.map(x => x.product.sku),
                status: 'pending',
                totalRecords: lote.length,
                owner: { id: userId } as any,
                connection: { id: connection.id } as any,
            }));

            // El enlace queda pendiente: Falabella confirma después si entró.
            for (const { product } of lote) {
                let link = await this.listingLinkRepository.findOne({
                    where: { product: { id: product.id }, connection: { id: connection.id } },
                });
                if (!link) {
                    link = this.listingLinkRepository.create({
                        marketplace: 'falabella',
                        externalId: product.sku,
                        product,
                        connection: { id: connection.id } as any,
                    });
                }
                link.syncStatus = 'pending';
                link.lastError = null as any;
                await this.listingLinkRepository.save(link);
            }

            // El estado se consulta en diferido: el procesado no es inmediato.
            await this.syncQueue.add(
                'falabella-feed',
                { feedRecordId: feed.id, userId },
                { delay: 30_000 },
            );

            lotes.push({ feedId, productos: lote.length });
        }

        return {
            message:
                `Enviados ${aceptados.length} productos a Falabella en ${lotes.length} ` +
                `${lotes.length === 1 ? 'lote' : 'lotes'}. Falabella los procesa en segundo plano; ` +
                `el estado se actualiza solo en unos minutos.`,
            enviados: aceptados.length,
            rechazados,
            lotes,
        };
    }

    /**
     * Consulta el estado de un lote y aplica el resultado a cada producto.
     * Si Falabella sigue procesando, se vuelve a preguntar más tarde.
     */
    async checkFalabellaFeed(feedRecordId: string, userId: string): Promise<{ status: string }> {
        const feed = await this.feedRepository.findOne({
            where: { id: feedRecordId },
            relations: { connection: true },
        });
        if (!feed) return { status: 'desconocido' };

        // Un lote anterior a las cuentas por tienda usa la primera cuenta del usuario.
        const feedConnectionId = feed.connection?.id
            ?? (await this.getValidConnection(userId, 'falabella')).id;
        const credentials = await this.getFalabellaCredentials(feedConnectionId);
        const estado = await this.falabellaApi.getFeedStatus(credentials, feed.externalFeedId);

        feed.status = estado.status;
        feed.totalRecords = estado.totalRecords || feed.totalRecords;
        feed.processedRecords = estado.processedRecords;
        feed.failedRecords = estado.failedRecords;
        feed.errors = estado.errors.length ? estado.errors : null;
        await this.feedRepository.save(feed);

        const terminado = /finished|canceled|error/i.test(estado.status);
        if (!terminado) {
            // Sigue en cola dentro de Falabella: se vuelve a mirar en un minuto.
            await this.syncQueue.add('falabella-feed', { feedRecordId, userId }, { delay: 60_000 });
            return { status: estado.status };
        }

        const erroresPorSku = new Map<string, string>();
        for (const error of estado.errors) {
            if (error.sku) erroresPorSku.set(error.sku, error.message);
        }

        // Los feeds de precio o stock no publican nada: se tratan aparte.
        if (feed.action !== 'ProductCreate') {
            return this.aplicarResultadoActualizacion(feed, userId, feedConnectionId, erroresPorSku, estado);
        }

        for (const sku of feed.skus || []) {
            const link = await this.listingLinkRepository.findOne({
                where: { connection: { id: feedConnectionId }, product: { sku } },
                relations: { product: true },
            });
            if (!link) continue;

            const error = erroresPorSku.get(sku);
            if (error) {
                link.syncStatus = 'error';
                link.lastError = error;
            } else {
                link.syncStatus = 'published';
                link.lastError = null as any;
                link.lastStockSynced = link.product?.stock ?? link.lastStockSynced;
                link.lastPriceSynced = link.product?.price ?? link.lastPriceSynced;
                link.lastSyncedAt = new Date();
            }
            await this.listingLinkRepository.save(link);
        }

        console.log(
            `[Sync] Feed Falabella ${feed.externalFeedId}: ${estado.status}, ` +
            `${estado.processedRecords} ok, ${estado.failedRecords} con error.`,
        );

        const correctos = Math.max(0, estado.processedRecords - estado.failedRecords);
        if (correctos > 0) {
            await this.notifications.notify(userId, {
                type: 'publish',
                severity: 'success',
                title: `Falabella publicó ${correctos} ${correctos === 1 ? 'producto' : 'productos'}`,
                body: `El lote terminó correctamente. Falabella los revisará antes de ponerlos a la venta.`,
                marketplace: 'falabella',
                meta: { feedId: feed.externalFeedId },
            });
        }
        if (estado.failedRecords > 0) {
            // Se listan los primeros motivos: con el detalle a la vista se
            // puede corregir sin entrar a buscarlo a otra pantalla.
            const detalle = estado.errors
                .slice(0, 3)
                .map(e => `${e.sku ? e.sku + ': ' : ''}${e.message}`)
                .join(' — ');
            await this.notifications.notify(userId, {
                type: 'publish-error',
                severity: 'error',
                title: `Falabella rechazó ${estado.failedRecords} ${estado.failedRecords === 1 ? 'producto' : 'productos'}`,
                body: detalle || 'Revisa el detalle del lote en Marketplaces.',
                marketplace: 'falabella',
                meta: { feedId: feed.externalFeedId, errors: estado.errors.slice(0, 10) },
            });
        }

        return { status: estado.status };
    }

    // ─────────────────────────────────────────────────────────────
    // Inventory sync (push)
    // ─────────────────────────────────────────────────────────────

    /**
     * Updates local stock/price and enqueues a push to every marketplace
     * where the product is published.
     */
    async updateInventory(scope: SyncScope, productId: string, dto: UpdateInventoryDto) {
        if (dto.stock === undefined && dto.price === undefined) {
            throw new BadRequestException('Envía al menos stock o price.');
        }

        const product = await this.findScopedProduct(scope, productId);

        // Solo las publicaciones de ESTA tienda: el producto puede estar en
        // cuentas de otra tienda del mismo dueño y esas no se tocan desde aquí.
        const links = await this.listingLinkRepository.find({
            where: {
                product: { id: productId },
                syncStatus: 'published',
                connection: { store: { id: scope.storeId } },
            },
            relations: { connection: true },
        });

        // Modo revisión: el cambio espera aprobación y no toca ni el producto
        // ni los canales. Sin canales publicados no hay nada que revisar.
        if (links.length && (await this.changeRequests.isReviewMode(scope.storeId))) {
            const solicitudes = await this.changeRequests.createFromInventory(
                scope,
                product,
                dto,
                links.map(l => ({ marketplace: l.marketplace, connectionId: l.connection!.id })),
            );
            return {
                pending: solicitudes.length,
                message: solicitudes.length
                    ? `Cambio en revisión: ${solicitudes.length} solicitud(es) esperan aprobación antes de enviarse a ${[...new Set(links.map(l => nombreCanal(l.marketplace)))].join(', ')}.`
                    : 'No hay cambios respecto a los valores actuales.',
            };
        }

        if (dto.stock !== undefined) product.stock = dto.stock;
        if (dto.price !== undefined) product.price = dto.price;
        await this.productRepository.save(product);

        for (const link of links) {
            await this.syncQueue.add('inventory', {
                productId,
                userId: scope.userId,
                marketplace: link.marketplace,
                connectionId: link.connection!.id,
            });
        }

        return {
            message: links.length
                ? `Inventario actualizado. Sincronizando con: ${[...new Set(links.map(l => nombreCanal(l.marketplace)))].join(', ')}.`
                : 'Inventario actualizado localmente. El producto aún no está publicado en ningún marketplace.',
        };
    }

    /** Executed by the queue processor: pushes current stock/price to Mercado Libre. */
    async pushInventoryToMeli(productId: string, connectionId?: string): Promise<void> {
        const product = await this.productRepository.findOne({ where: { id: productId } });
        const link = await this.listingLinkRepository.findOne({
            where: {
                marketplace: 'mercadolibre',
                product: { id: productId },
                syncStatus: 'published',
                ...(connectionId ? { connection: { id: connectionId } } : {}),
            },
            relations: { connection: true },
        });
        if (!product || !link || !link.connection) return;

        try {
            const connection = await this.getValidConnectionById(link.connection.id);
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

    /**
     * Ejecutado por la cola: empuja a Falabella el stock y precio actuales.
     *
     * Solo se manda lo que cambió respecto a la última sincronización, porque
     * cada feed gasta una de las 50 llamadas seguidas que admite Falabella.
     * Los valores quedan anotados en el enlace al enviarse; si el feed
     * resulta fallido, checkFalabellaFeed los borra para que el desajuste
     * quede a la vista en lugar de aparentar que todo está al día.
     */
    async pushInventoryToFalabella(
        productId: string,
        connectionId?: string,
    ): Promise<{ status: string; feeds: string[] }> {
        const product = await this.productRepository.findOne({ where: { id: productId } });
        const link = await this.listingLinkRepository.findOne({
            where: {
                marketplace: 'falabella',
                product: { id: productId },
                syncStatus: 'published',
                ...(connectionId ? { connection: { id: connectionId } } : {}),
            },
            relations: { connection: { owner: true } },
        });
        if (!product || !link || !link.connection) return { status: 'omitido', feeds: [] };

        const precioCambio =
            link.lastPriceSynced === null || link.lastPriceSynced === undefined ||
            Number(link.lastPriceSynced) !== Number(product.price);
        const stockCambio = link.lastStockSynced !== product.stock;
        if (!precioCambio && !stockCambio) return { status: 'sin-cambios', feeds: [] };

        // El SKU del vendedor es lo que casa con la ficha de Falabella.
        const sellerSku = product.sku;
        const feeds: string[] = [];
        const ownerId = link.connection.owner.id;

        try {
            const credentials = await this.getFalabellaCredentials(link.connection.id);
            const opts = { operatorCode: this.falabellaOperatorCode };

            if (precioCambio) {
                feeds.push(await this.registrarFeedFalabella(
                    ownerId, link.connection.id, 'ProductUpdate', sellerSku,
                    await this.falabellaApi.updatePrice(credentials, sellerSku, Number(product.price), opts),
                ));
            }
            if (stockCambio) {
                feeds.push(await this.registrarFeedFalabella(
                    ownerId, link.connection.id, 'UpdateStock', sellerSku,
                    await this.falabellaApi.updateStock(credentials, [{ sellerSku, quantity: product.stock }], opts),
                ));
            }
        } catch (error: any) {
            link.lastError = this.describeApiError(error);
            await this.listingLinkRepository.save(link);
            throw error;
        }

        if (precioCambio) link.lastPriceSynced = product.price;
        if (stockCambio) link.lastStockSynced = product.stock;
        link.lastSyncedAt = new Date();
        link.lastError = null as any;
        await this.listingLinkRepository.save(link);

        return { status: 'enviado', feeds };
    }

    /** Anota un feed de actualización y programa la consulta de su resultado. */
    private async registrarFeedFalabella(
        userId: string,
        connectionId: string,
        action: 'ProductUpdate' | 'UpdateStock',
        sku: string,
        externalFeedId: string,
    ): Promise<string> {
        const feed = await this.feedRepository.save(this.feedRepository.create({
            marketplace: 'falabella',
            externalFeedId,
            action,
            skus: [sku],
            status: 'pending',
            totalRecords: 1,
            owner: { id: userId } as any,
            connection: { id: connectionId } as any,
        }));
        await this.syncQueue.add('falabella-feed', { feedRecordId: feed.id, userId }, { delay: 30_000 });
        return externalFeedId;
    }

    /**
     * Aplica el resultado de un feed de precio o stock. A diferencia del alta,
     * aquí la ficha ya está publicada: un fallo no cambia su estado, solo
     * deja el motivo en el enlace y borra el dato que no llegó a Falabella.
     */
    private async aplicarResultadoActualizacion(
        feed: MarketplaceFeed,
        userId: string,
        connectionId: string,
        erroresPorSku: Map<string, string>,
        estado: { failedRecords: number; errors: { sku?: string; message: string }[] },
    ) {
        // Un feed que termina en error sin detalle por SKU falla entero.
        const falloTotal =
            (/error|canceled/i.test(feed.status) || estado.failedRecords > 0) && erroresPorSku.size === 0;

        for (const sku of feed.skus || []) {
            // Se busca por el SKU del producto: en fichas importadas el externalId es el ShopSku.
            const link = await this.listingLinkRepository.findOne({
                where: { connection: { id: connectionId }, product: { sku } },
            });
            if (!link) continue;

            const error = erroresPorSku.get(sku) ?? (falloTotal ? `El lote ${feed.action} terminó con error.` : undefined);
            if (error) {
                link.lastError = error;
                if (feed.action === 'UpdateStock') link.lastStockSynced = null as any;
                if (feed.action === 'ProductUpdate') link.lastPriceSynced = null as any;
            } else {
                link.lastError = null as any;
            }
            await this.listingLinkRepository.save(link);
        }

        if (estado.failedRecords > 0 || falloTotal) {
            const detalle = estado.errors.slice(0, 3).map(e => `${e.sku ? e.sku + ': ' : ''}${e.message}`).join(' — ');
            await this.notifications.notify(userId, {
                type: 'publish-error',
                severity: 'error',
                title: feed.action === 'UpdateStock'
                    ? 'Falabella no aceptó un cambio de stock'
                    : 'Falabella no aceptó un cambio de precio',
                body: detalle || 'Revisa el detalle del lote en Marketplaces.',
                marketplace: 'falabella',
                meta: { feedId: feed.externalFeedId, errors: estado.errors.slice(0, 10) },
            });
        }
        return { status: feed.status };
    }

    // ─────────────────────────────────────────────────────────────
    // Falabella: pedidos entrantes por webhook
    // ─────────────────────────────────────────────────────────────

    /** Eventos que nos interesan: una venta nueva y los cambios de estado. */
    private readonly FALABELLA_EVENTS = ['onOrderCreated', 'onOrderItemsStatusChanged'];

    /** URL pública de este servidor, a la que Falabella enviará los avisos. */
    private get publicApiUrl(): string {
        return (process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');
    }

    /**
     * Da de alta el webhook de Falabella para esta cuenta.
     *
     * Falabella no firma sus llamadas ni manda ninguna credencial, así que la
     * identidad viaja en la propia URL: cada cuenta recibe una dirección con
     * un testigo aleatorio que solo conoce ella. Eso resuelve dos cosas a la
     * vez — saber de qué vendedor es el aviso, y que nadie de fuera pueda
     * inventarse ventas llamando a nuestro endpoint.
     *
     * Se AÑADE a los webhooks existentes. La cuenta de este vendedor ya tiene
     * uno apuntando a Yuju; borrarlo le dejaría sin recibir sus ventas allí
     * mientras dure la convivencia entre ambos sistemas.
     */
    async registerFalabellaWebhook(scope: SyncScope, connectionId?: string) {
        if (!this.publicApiUrl) {
            throw new BadRequestException(
                'Falta configurar PUBLIC_API_URL: sin la dirección pública de este servidor, ' +
                'Falabella no sabría dónde avisar de las ventas.',
            );
        }

        const connection = await this.resolveConnection(scope.storeId, 'falabella', connectionId);
        const credentials = { userId: connection.externalUserId, apiKey: connection.accessToken };

        // El testigo se conserva entre llamadas: si ya había uno, se reutiliza
        // para no dejar huérfano el webhook que Falabella ya conoce.
        const secrets = (connection.secrets as any) || {};
        const token: string = secrets.webhookToken || randomUUID();
        const callbackUrl = `${this.publicApiUrl}/api/v1/sync/webhooks/falabella/${token}`;

        const existentes = await this.falabellaApi.getWebhooks(credentials);
        const ajenos = existentes.filter(w => w.CallbackUrl !== callbackUrl);
        const yaEsta = existentes.find(w => w.CallbackUrl === callbackUrl);

        let webhookId = yaEsta?.WebhookId;
        if (!yaEsta) {
            webhookId = await this.falabellaApi.createWebhook(
                credentials,
                callbackUrl,
                this.FALABELLA_EVENTS,
            );
        }

        connection.secrets = { ...secrets, webhookToken: token, webhookId };
        await this.connectionRepository.save(connection);

        return {
            message: yaEsta
                ? 'El aviso de ventas ya estaba configurado.'
                : 'Falabella avisará a Synkro de cada venta nueva.',
            callbackUrl,
            otrosWebhooks: ajenos.map(w => w.CallbackUrl),
        };
    }

    /**
     * Entrada pública de los avisos de Falabella.
     *
     * Se responde de inmediato y el trabajo real va a la cola: Falabella
     * reintenta durante 30 días si no recibe respuesta rápida, y no queremos
     * que una consulta lenta le haga pensar que fallamos.
     *
     * El contenido del aviso no se cree a ciegas: solo se usa como pista de
     * que "algo pasó". Los datos buenos se piden después a la API, que es la
     * fuente de verdad.
     */
    async handleFalabellaNotification(token: string, body: any): Promise<{ received: boolean }> {
        const connection = await this.findConnectionByWebhookToken(token);
        if (!connection) {
            console.warn('[Sync] Aviso de Falabella con un testigo desconocido. Se ignora.');
            return { received: true };
        }

        await this.syncQueue.add('falabella-order', {
            userId: connection.owner.id,
            connectionId: connection.id,
            hint: body?.payload?.OrderId ?? body?.OrderId ?? null,
        });
        return { received: true };
    }

    /**
     * Busca la conexión a la que pertenece un testigo de webhook.
     * Los testigos viven cifrados, así que se comparan en memoria; son pocas
     * conexiones y esto evita guardarlos en claro solo para poder indexarlos.
     */
    private async findConnectionByWebhookToken(token: string): Promise<MarketplaceConnection | null> {
        if (!token) return null;
        const conexiones = await this.connectionRepository.find({
            where: { marketplace: 'falabella' },
            relations: { owner: true },
        });
        return conexiones.find(c => (c.secrets as any)?.webhookToken === token) ?? null;
    }

    /**
     * Trae los pedidos recientes de Falabella y aplica los que sean nuevos.
     *
     * Se consulta por fecha en vez de fiarse del aviso: así un webhook
     * perdido no deja una venta sin registrar, y sirve igual para ponerse al
     * día a mano después de una caída.
     */
    async processFalabellaOrders(
        ref: { userId: string; storeId?: string; connectionId?: string },
        options: { desdeHoras?: number } = {},
    ) {
        // Un aviso sin cuenta (encolado antes de este cambio) usa la primera
        // cuenta de Falabella del usuario.
        const connection = ref.connectionId
            ? await this.getValidConnectionById(ref.connectionId)
            : ref.storeId
                ? await this.resolveConnection(ref.storeId, 'falabella')
                : await this.getValidConnection(ref.userId, 'falabella');
        const userId = ref.userId;
        const credentials = { userId: connection.externalUserId, apiKey: connection.accessToken };
        const monedaCuenta = connection.currency ?? undefined;
        const desde = new Date(Date.now() - (options.desdeHoras ?? 48) * 60 * 60 * 1000);

        const pedidos = await this.falabellaApi.getOrders(credentials, {
            createdAfter: desde,
            limit: 100,
        });

        let nuevos = 0;
        let repetidos = 0;

        for (const pedido of pedidos) {
            const externalId = String((pedido as any).OrderId ?? '');
            if (!externalId) continue;

            const yaRegistrado = await this.orderRepository.findOne({
                where: { marketplace: 'falabella', externalId },
            });
            if (yaRegistrado) { repetidos++; continue; }

            const items = await this.falabellaApi.getOrderItems(credentials, externalId);

            await this.orderRepository.save(this.orderRepository.create({
                marketplace: 'falabella',
                externalId,
                owner: { id: userId } as any,
                totalAmount: Number((pedido as any).Price ?? (pedido as any).GrandTotal ?? 0),
                // Falabella no siempre manda la moneda; si no viene, se usa la
                // del país de envío y, en último caso, la guardada al conectar.
                currency: resolverMoneda(
                    (pedido as any).Currency,
                    monedaDePais((pedido as any).AddressShipping?.Country),
                    monedaCuenta,
                ),
                itemsCount: Number((pedido as any).ItemsCount ?? items.length ?? 1),
                items: items.map(i => ({
                    sku: i.Sku ?? null,
                    title: i.Name,
                    quantity: 1, // Falabella devuelve una línea por unidad vendida
                    unitPrice: Number(i.PaidPrice ?? i.ItemPrice ?? 0),
                })),
                status: String((pedido as any).Statuses?.Status ?? 'pending'),
                orderDate: (pedido as any).CreatedAt ? new Date((pedido as any).CreatedAt) : new Date(),
            }));
            nuevos++;

            await this.aplicarVentaFalabella(userId, connection, externalId, items, pedido);
        }

        if (nuevos) {
            console.log(`[Sync] Falabella: ${nuevos} pedidos nuevos, ${repetidos} ya registrados.`);
        }
        return { nuevos, repetidos, revisados: pedidos.length };
    }

    /** Descuenta stock y avisa por cada línea vendida en Falabella. */
    private async aplicarVentaFalabella(
        userId: string,
        connection: MarketplaceConnection,
        orderId: string,
        items: any[],
        pedido: any,
    ): Promise<void> {
        const storeId = connection.store?.id;
        for (const item of items) {
            const sku = item?.Sku;
            if (!sku) continue;

            // El producto de la tienda de esta cuenta; si es anterior a las
            // tiendas (sin tienda asignada), el del dueño.
            const product = await this.productRepository.findOne({
                where: storeId
                    ? [{ sku, store: { id: storeId } }, { sku, store: IsNull(), owner: { id: userId } }]
                    : [{ sku, owner: { id: userId } }],
            });
            if (!product) {
                console.warn(`[Sync] Venta Falabella ${orderId}: SKU ${sku} no está en el catálogo.`);
                continue;
            }

            product.stock = Math.max(0, product.stock - 1);
            await this.productRepository.save(product);

            await this.notifications.notify(userId, {
                type: 'sale',
                severity: 'success',
                title: `Venta en Falabella: ${product.name}`,
                body:
                    `Pedido ${(pedido as any).OrderNumber ?? orderId} por PEN ` +
                    `${Number(item.PaidPrice ?? item.ItemPrice ?? 0).toFixed(2)}. ` +
                    `Quedan ${product.stock} unidades de ${sku}.`,
                marketplace: 'falabella',
                meta: { orderId, productId: product.id, sku },
            });

            if (product.stock === 0) {
                await this.notifications.notify(userId, {
                    type: 'low-stock',
                    severity: 'error',
                    title: `Sin stock: ${product.name}`,
                    body: `${sku} se quedó en cero tras la venta en Falabella.`,
                    marketplace: 'falabella',
                    meta: { productId: product.id, sku, stock: 0 },
                });
            }

            // Propagar el nuevo stock a las demás cuentas donde esté publicado.
            const otros = await this.listingLinkRepository.find({
                where: { product: { id: product.id }, syncStatus: 'published' },
                relations: { connection: true },
            });
            for (const enlace of otros) {
                if (!enlace.connection || enlace.connection.id === connection.id) continue;
                await this.syncQueue.add('inventory', {
                    productId: product.id,
                    userId,
                    marketplace: enlace.marketplace,
                    connectionId: enlace.connection.id,
                });
            }
        }
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
        // La misma cuenta de Mercado Libre puede estar conectada en más de una
        // tienda; la venta se aplica en cada una cuyo catálogo tenga el ítem.
        const connections = await this.connectionRepository.find({
            where: { marketplace: 'mercadolibre', externalUserId: meliUserId, status: 'active' },
            select: { id: true },
        });
        if (!connections.length) {
            console.warn(`[Sync] Notificación de ML para un seller no conectado: ${meliUserId}`);
            return;
        }
        for (const { id } of connections) {
            await this.applyMeliOrder(resource, id);
        }
    }

    private async applyMeliOrder(resource: string, connectionId: string): Promise<void> {
        const connection = await this.getValidConnectionById(connectionId);
        const userId = connection.owner.id;
        const orderId = resource.split('/').pop() as string;
        const order = await this.meliApi.getOrder(connection.accessToken, orderId);

        if (order.status !== 'paid') return; // only confirmed sales move stock

        // Idempotency: never apply the same order twice to the same account (webhooks can repeat)
        const dedupeKey = `meli:order-applied:${connection.id}:${orderId}`;
        const firstTime = await this.redis.set(dedupeKey, '1', 'EX', 60 * 60 * 24 * 30, 'NX');
        if (!firstTime) return;

        // Persist the sale — feeds the client sales report and orders panel
        try {
            await this.orderRepository.save(this.orderRepository.create({
                marketplace: 'mercadolibre',
                externalId: String(orderId),
                owner: { id: userId } as any,
                totalAmount: Number(order.total_amount || 0),
                currency: resolverMoneda(order.currency_id, await this.monedaDeCuenta(connection.id)),
                itemsCount: (order.order_items || []).reduce((s: number, i: any) => s + Number(i?.quantity || 0), 0) || 1,
                items: (order.order_items || []).map((i: any) => ({
                    sku: i?.item?.seller_sku || null,
                    title: i?.item?.title,
                    quantity: Number(i?.quantity || 0),
                    unitPrice: Number(i?.unit_price || 0),
                })),
                status: order.status,
                orderDate: order.date_closed ? new Date(order.date_closed) : new Date(),
            }));
        } catch (error: any) {
            // UQ violation = ya registrada (carrera entre webhooks) — seguir sin romper
            console.warn(`[Sync] Orden ${orderId} no persistida: ${error?.message}`);
        }

        for (const orderItem of order.order_items || []) {
            const externalId = orderItem?.item?.id;
            const quantity = Number(orderItem?.quantity || 0);
            if (!externalId || !quantity) continue;

            const link = await this.listingLinkRepository.findOne({
                where: { marketplace: 'mercadolibre', externalId, connection: { id: connection.id } },
                relations: { product: true },
            });
            if (!link) continue;

            const product = link.product;
            product.stock = Math.max(0, product.stock - quantity);
            await this.productRepository.save(product);
            console.log(`[Sync] Venta ML ${orderId}: ${quantity}x ${product.sku} → stock ${product.stock}`);

            await this.notifications.notify(userId, {
                type: 'sale',
                severity: 'success',
                title: `Venta en Mercado Libre: ${quantity} x ${product.name}`,
                body:
                    `Pedido ${orderId} por ${resolverMoneda(order.currency_id)} ${Number(order.total_amount || 0).toFixed(2)}. ` +
                    `Quedan ${product.stock} unidades de ${product.sku}.`,
                marketplace: 'mercadolibre',
                meta: { orderId, productId: product.id, sku: product.sku, quantity },
            });

            // Avisar cuando el stock se está acabando, mientras aún da tiempo
            // a reponer. Se avisa al cruzar el umbral y no por debajo, para
            // no repetir el mismo aviso en cada venta.
            if (product.stock > 0 && product.stock <= LOW_STOCK_THRESHOLD &&
                product.stock + quantity > LOW_STOCK_THRESHOLD) {
                await this.notifications.notify(userId, {
                    type: 'low-stock',
                    severity: 'warning',
                    title: `Se está agotando: ${product.name}`,
                    body: `Quedan ${product.stock} unidades de ${product.sku}. Repone antes de quedarte sin stock publicado.`,
                    marketplace: 'mercadolibre',
                    meta: { productId: product.id, sku: product.sku, stock: product.stock },
                });
            } else if (product.stock === 0) {
                await this.notifications.notify(userId, {
                    type: 'low-stock',
                    severity: 'error',
                    title: `Sin stock: ${product.name}`,
                    body: `${product.sku} se quedó en cero tras la última venta. La publicación dejará de vender.`,
                    marketplace: 'mercadolibre',
                    meta: { productId: product.id, sku: product.sku, stock: 0 },
                });
            }

            // Propagate the new stock to every OTHER account where it's published
            const otherLinks = await this.listingLinkRepository.find({
                where: { product: { id: product.id }, syncStatus: 'published' },
                relations: { connection: true },
            });
            for (const other of otherLinks) {
                if (!other.connection || other.connection.id === connection.id) continue;
                await this.syncQueue.add('inventory', {
                    productId: product.id,
                    userId,
                    marketplace: other.marketplace,
                    connectionId: other.connection.id,
                });
            }
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Status
    // ─────────────────────────────────────────────────────────────

    /** All the user's listings across marketplaces, for the Marketplaces UI. */
    async getAllListings(storeId: string) {
        const links = await this.listingLinkRepository.find({
            where: { connection: { store: { id: storeId } } },
            relations: { product: true, connection: true },
            order: { updatedAt: 'DESC' },
        });

        return links.map(l => ({
            // La moneda depende de la cuenta: la misma tienda puede vender en
            // soles en Mercado Libre y en pesos en una cuenta de Falabella Colombia.
            currency: l.connection?.currency ?? monedaPorDefecto(),
            id: l.id,
            productId: l.product.id,
            productName: l.product.name,
            sku: l.product.sku,
            stock: l.product.stock,
            price: l.product.price,
            marketplace: l.marketplace,
            connectionId: l.connection?.id ?? null,
            accountLabel: l.connection?.label || l.connection?.externalNickname || null,
            externalId: l.externalId,
            permalink: l.permalink,
            syncStatus: l.syncStatus,
            lastStockSynced: l.lastStockSynced,
            lastPriceSynced: l.lastPriceSynced,
            regularPrice: l.regularPrice,
            salePrice: l.salePrice,
            imageUrl: l.imageUrl,
            variation: l.variation,
            parentSku: l.parentSku,
            webPrice: l.product.webPrice,
            lastSyncedAt: l.lastSyncedAt,
            lastError: l.lastError,
        }));
    }

    /**
     * Fija el precio con descuento de la tienda web. No pasa por la cola de
     * revisión ni toca ningún marketplace: es un dato solo de la web propia,
     * que se enviará a WooCommerce cuando esa conexión exista.
     */
    async setWebPrice(scope: SyncScope, productId: string, webPrice: number | null) {
        const product = await this.findScopedProduct(scope, productId);
        product.webPrice = webPrice;
        await this.productRepository.save(product);
        return { productId, webPrice, message: webPrice === null ? 'Precio web quitado.' : 'Precio web guardado.' };
    }

    async getProductSyncStatus(scope: SyncScope, productId: string) {
        const product = await this.findScopedProduct(scope, productId);
        const links = await this.listingLinkRepository.find({
            where: { product: { id: productId }, connection: { store: { id: scope.storeId } } },
            relations: { connection: true },
        });
        return {
            productId,
            sku: product.sku,
            stock: product.stock,
            price: product.price,
            listings: links.map(l => ({
                marketplace: l.marketplace,
                connectionId: l.connection?.id ?? null,
                accountLabel: l.connection?.label || l.connection?.externalNickname || null,
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
