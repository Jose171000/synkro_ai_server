import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from '../../products/entities/product.entity';
import { ListingLink } from '../entities/listing-link.entity';
import { NotificationsService } from '../../notifications/notifications.service';
import { SyncService } from '../sync.service';
import { YavendioApiService, YavendioProduct } from './yavendio-api.service';
import { estadoDeVariante, PlanInvalido, planificarYavendio, PlanYavendio } from './yavendio-plan';

const MARKETPLACE = 'yavendio';
const clave = (v: string) => String(v ?? '').trim().toLowerCase();

/**
 * Publicar y mantener al día productos en Yavendió.
 *
 * Yavendió no usa SKU para nada, así que el vínculo es el enlace interno: cada producto (o variante) de Synkro guarda en su
 * `ListingLink` el id del producto de Yavendió (`externalId`) y el de su variante (`variationId`). Con eso se actualiza
 * precio y disponibilidad y se asocian los pedidos. El SKU NO se escribe en Yavendió.
 *
 * Un grupo de variantes de Synkro es un único producto de Yavendió (opciones → variantes → fotos por variante).
 * No hay stock numérico en la API: Synkro manda y a Yavendió solo le dice `available` o `not_available`.
 */
@Injectable()
export class YavendioSyncService {
    private readonly logger = new Logger(YavendioSyncService.name);

    constructor(
        @InjectRepository(Product) private readonly productRepository: Repository<Product>,
        @InjectRepository(ListingLink) private readonly listingLinkRepository: Repository<ListingLink>,
        private readonly api: YavendioApiService,
        private readonly sync: SyncService,
        private readonly notifications: NotificationsService,
    ) { }

    /** El producto y, si es una variante, todas las de su grupo: en Yavendió se publican juntas. */
    private async cargarFamilia(productId: string): Promise<{ producto: Product; familia: Product[] }> {
        const producto = await this.productRepository.findOne({ where: { id: productId }, relations: { group: true } });
        if (!producto) throw new NotFoundException('Producto no encontrado');
        if (!producto.group) return { producto, familia: [producto] };
        const familia = await this.productRepository.find({ where: { group: { id: producto.group.id } }, relations: { group: true }, order: { createdAt: 'ASC' } });
        return { producto, familia };
    }

    /**
     * Publica el producto (o su grupo entero) en la cuenta. Se puede repetir sin duplicar: si ya existe el producto de Yavendió
     * solo se completan las opciones y variantes que falten, y cada paso queda guardado en el enlace apenas se logra.
     */
    async publish(productId: string, userId: string, connectionId: string): Promise<{ externalId: string; creadas: number }> {
        const { familia } = await this.cargarFamilia(productId);
        const grupo = familia[0].group ? { name: familia[0].group.name, axes: familia[0].group.axes } : null;

        let plan: PlanYavendio;
        try {
            plan = planificarYavendio(familia, grupo);
        } catch (error) {
            if (error instanceof PlanInvalido) throw new BadRequestException(error.message);
            throw error;
        }

        const connection = await this.sync.getValidConnectionById(connectionId);
        const apiKey = connection.accessToken;
        const moneda = String((connection.secrets as any)?.currency ?? '').toUpperCase();
        if (!moneda) throw new BadRequestException('No se conoce la moneda del catálogo de Yavendió: vuelve a conectar la cuenta.');

        const enlaces = new Map<string, ListingLink>();
        for (const producto of familia) {
            const enlace = await this.listingLinkRepository.findOne({ where: { product: { id: producto.id }, connection: { id: connectionId } } });
            if (enlace) enlaces.set(producto.id, enlace);
        }
        // Un enlace cerrado («removed») ya no apunta a nada vivo: se ignora y se publica de nuevo.
        const vivos = [...enlaces.values()].filter((e) => e.syncStatus !== 'removed' && e.externalId);
        let yavendioProductId = vivos[0]?.externalId ?? '';

        if (!yavendioProductId) {
            const catalogos = await this.api.listCatalogs(apiKey);
            if (!catalogos.length) throw new BadRequestException('Yavendió no devolvió ningún catálogo para esta cuenta.');
            const creado = await this.api.createProduct(apiKey, { catalog_id: catalogos[0].id, name: plan.name, description: plan.description });
            yavendioProductId = String(creado.id);
            // Se anota ya en el enlace de cada variante: si algo falla más adelante, el reintento reutiliza este producto.
            for (const producto of familia) {
                const enlace = await this.guardarEnlace(producto, connectionId, enlaces.get(producto.id), { externalId: yavendioProductId, variationId: null, syncStatus: 'pending', lastError: null as any });
                enlaces.set(producto.id, enlace);
            }
        }

        const remoto: YavendioProduct = await this.api.getProduct(apiKey, yavendioProductId);
        const valores = await this.asegurarOpciones(apiKey, yavendioProductId, plan, remoto);

        let creadas = 0;
        const errores: string[] = [];
        for (const variante of plan.variants) {
            const producto = familia.find((p) => p.id === variante.productId)!;
            const enlace = enlaces.get(producto.id);
            if (enlace?.variationId && enlace.syncStatus !== 'removed') continue; // ya está creada

            try {
                const ids = variante.optionValues.map((o) => valores.get(`${clave(o.option)}|${clave(o.value)}`)!);
                const nueva = await this.api.createVariant(apiKey, yavendioProductId, {
                    name: variante.name,
                    base_price: variante.price,
                    currency: moneda,
                    status: variante.status,
                    option_values: ids,
                });
                const guardado = await this.guardarEnlace(producto, connectionId, enlace, {
                    externalId: yavendioProductId,
                    variationId: String(nueva.id),
                    syncStatus: 'published',
                    lastError: null as any,
                    lastPriceSynced: variante.price,
                    lastStockSynced: producto.stock,
                    regularPrice: variante.price,
                    imageUrl: variante.images[0] ?? null,
                    variation: variante.optionValues.map((o) => o.value).join(' / '),
                    parentSku: producto.group?.parentSku ?? null,
                    lastSyncedAt: new Date(),
                });
                enlaces.set(producto.id, guardado);
                creadas++;
                for (const url of variante.images) await this.api.addVariantMedia(apiKey, yavendioProductId, nueva.id, url);
            } catch (error: any) {
                errores.push(`${variante.sku}: ${error?.message ?? 'error desconocido'}`);
                const e = enlaces.get(producto.id);
                if (e && !e.variationId) await this.guardarEnlace(producto, connectionId, e, { syncStatus: 'error', lastError: String(error?.message ?? '').slice(0, 500) });
            }
        }

        if (errores.length) {
            // Falla el trabajo para que la cola reintente solo lo que falta (lo ya creado no se repite).
            throw new Error(`No se pudieron crear ${errores.length} variante(s) en Yavendió. ${errores[0]}`);
        }
        return { externalId: yavendioProductId, creadas };
    }

    /** Crea en Yavendió las opciones y valores que falten y devuelve el id de cada «opción|valor». */
    private async asegurarOpciones(apiKey: string, productId: string, plan: PlanYavendio, remoto: YavendioProduct): Promise<Map<string, number>> {
        const ids = new Map<string, number>();
        const opcionesRemotas = remoto.options ?? [];
        for (const opcion of plan.options) {
            let remota = opcionesRemotas.find((o) => clave(o.name) === clave(opcion.name));
            if (!remota) {
                remota = await this.api.createOption(apiKey, productId, opcion.name, opcion.values);
            } else {
                for (const valor of opcion.values) {
                    if (remota.values.some((v) => clave(v.name) === clave(valor))) continue;
                    const nuevo = await this.api.addOptionValue(apiKey, productId, remota.id, valor);
                    remota.values = [...remota.values, nuevo];
                }
            }
            for (const v of remota.values) ids.set(`${clave(opcion.name)}|${clave(v.name)}`, v.id);
        }
        return ids;
    }

    private async guardarEnlace(producto: Product, connectionId: string, enlace: ListingLink | undefined, cambios: Partial<ListingLink>): Promise<ListingLink> {
        const base = enlace ?? this.listingLinkRepository.create({ marketplace: MARKETPLACE, product: producto, connection: { id: connectionId } as any });
        // Un enlace cerrado que se vuelve a publicar empieza de cero.
        if (base.syncStatus === 'removed') Object.assign(base, { externalId: '', variationId: null, permalink: null });
        Object.assign(base, cambios);
        return this.listingLinkRepository.save(base);
    }

    /** Anota el fallo definitivo de una publicación y avisa a la persona (los reintentos ya se agotaron). */
    async marcarFallida(productId: string, connectionId: string, userId: string, motivo: string): Promise<void> {
        const { familia } = await this.cargarFamilia(productId).catch(() => ({ familia: [] as Product[] }));
        for (const producto of familia) {
            const enlace = await this.listingLinkRepository.findOne({ where: { product: { id: producto.id }, connection: { id: connectionId } } });
            if (enlace && enlace.syncStatus !== 'published') await this.guardarEnlace(producto, connectionId, enlace, { syncStatus: 'error', lastError: motivo.slice(0, 500) });
        }
        await this.notifications.notify(userId, {
            type: 'publish-error',
            severity: 'error',
            title: `No se pudo publicar ${familia[0]?.sku ?? productId} en Yavendió`,
            body: motivo.slice(0, 300),
            marketplace: MARKETPLACE,
            meta: { productId, connectionId },
        });
    }

    /**
     * Envía a Yavendió el precio y la disponibilidad actuales de un producto ya publicado.
     * Si la variante ya no existe allá (404) el enlace queda en error para vincularla de nuevo; no se crea nada solo.
     */
    async pushInventory(productId: string, connectionId: string): Promise<void> {
        const producto = await this.productRepository.findOne({ where: { id: productId } });
        const enlace = await this.listingLinkRepository.findOne({ where: { product: { id: productId }, connection: { id: connectionId }, marketplace: MARKETPLACE } });
        if (!producto || !enlace?.externalId || !enlace.variationId || enlace.syncStatus === 'removed') return;
        const precio = Number(producto.price);
        if (!(precio > 0)) throw new BadRequestException(`${producto.sku}: sin precio no se puede actualizar en Yavendió.`);

        const connection = await this.sync.getValidConnectionById(connectionId);
        try {
            await this.api.updateVariant(connection.accessToken, enlace.externalId, enlace.variationId, {
                base_price: precio,
                status: estadoDeVariante(producto.stock, enlace.pausedByUser),
            });
        } catch (error: any) {
            if (error?.yavendioStatus === 404) {
                await this.guardarEnlace(producto, connectionId, enlace, { syncStatus: 'error', lastError: 'La variante ya no existe en Yavendió: hay que vincularla de nuevo.' });
                return;
            }
            throw error;
        }
        await this.guardarEnlace(producto, connectionId, enlace, {
            lastPriceSynced: precio,
            lastStockSynced: producto.stock,
            regularPrice: precio,
            lastSyncedAt: new Date(),
            lastError: null as any,
            syncStatus: enlace.pausedByUser ? 'paused' : 'published',
        });
    }
}
