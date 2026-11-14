import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from '../../products/entities/product.entity';
import { ListingLink } from '../entities/listing-link.entity';
import { NotificationsService } from '../../notifications/notifications.service';
import { SyncService } from '../sync.service';
import { EcommerceSyncService } from '../channels/ecommerce-sync.service';
import { normalizarSitioWoo, WooApiService } from './woo-api.service';
import { CategoriaElegida, WooCategoriasService } from './woo-categorias.service';
import { PlanInvalido, planificarWoo, PlanWoo } from './woo-plan';

const MARKETPLACE = 'woocommerce';
const clave = (v: unknown) => String(v ?? '').trim().toLowerCase();

/**
 * Publicar productos de Synkro en una tienda WooCommerce (siempre como BORRADOR: la persona los revisa y los publica en WordPress).
 *
 * El vínculo es el enlace interno (`ListingLink`): `externalId` = id del producto en WooCommerce y `variationId` = id de la
 * variación (nulo en un producto simple). Con eso el stock, el precio y las ventas siguen sincronizados como en los demás canales.
 * Un grupo de variantes es UN producto «variable» con una variación por variante. Se puede repetir sin duplicar: lo que ya se creó
 * se reutiliza y solo se completa lo que falta.
 */
@Injectable()
export class WooPublicacionService {
    private readonly logger = new Logger(WooPublicacionService.name);

    constructor(
        @InjectRepository(Product) private readonly productRepository: Repository<Product>,
        @InjectRepository(ListingLink) private readonly listingLinkRepository: Repository<ListingLink>,
        private readonly api: WooApiService,
        private readonly sync: SyncService,
        private readonly ecommerce: EcommerceSyncService,
        private readonly categorias: WooCategoriasService,
        private readonly notifications: NotificationsService,
    ) { }

    /** El producto y, si es una variante, todas las de su grupo: en WooCommerce se publican juntas. */
    private async cargarFamilia(productId: string): Promise<Product[]> {
        const producto = await this.productRepository.findOne({ where: { id: productId }, relations: { group: true } });
        if (!producto) throw new NotFoundException('Producto no encontrado');
        if (!producto.group) return [producto];
        const familia = await this.productRepository.find({ where: { group: { id: producto.group.id } }, relations: { group: true }, order: { createdAt: 'ASC' } });
        return familia.length ? familia : [producto];
    }

    /**
     * Publica el producto (o su grupo entero) en la tienda. Se crea oculto (borrador), se le ponen las variaciones y las fotos y SOLO AL FINAL
     * se publica: así nunca queda a la venta un producto a medias. Con WOO_PUBLICAR_COMO_BORRADOR=true se queda en borrador para revisarlo en WordPress.
     */
    async publish(productId: string, userId: string, connectionId: string): Promise<{ externalId: string; creadas: number; publicado: boolean }> {
        const familia = await this.cargarFamilia(productId);
        const grupo = familia[0].group ? { name: familia[0].group.name, axes: familia[0].group.axes } : null;
        const plan: PlanWoo = planificarWoo(familia, grupo); // lanza PlanInvalido si algo no sirve: reintentar no lo arregla

        const connection = await this.sync.getValidConnectionById(connectionId);
        const auth = this.ecommerce.authOf(connection);

        const enlaces = new Map<string, ListingLink>();
        for (const p of familia) {
            const e = await this.listingLinkRepository.findOne({ where: { product: { id: p.id }, connection: { id: connectionId } } });
            if (e) enlaces.set(p.id, e);
        }
        // Un enlace cerrado («removed») ya no apunta a nada vivo: se ignora y se publica de nuevo.
        const vivos = [...enlaces.values()].filter((e) => e.syncStatus !== 'removed' && e.externalId);
        let wooId = vivos[0]?.externalId ?? '';
        let permalink: string | null = vivos[0]?.permalink ?? null;

        // La categoría se elige sola entre las que ya tiene la tienda (nunca se crean). Sin una que encaje, el producto se crea igual
        // en la categoría por defecto de WordPress y se avisa para que la persona la elija.
        const categoria: CategoriaElegida | null = await this.categorias.elegir(familia, connectionId).catch((e) => {
            this.logger.warn(`No se pudo elegir la categoría de WooCommerce: ${e?.message}`);
            return null;
        });

        if (!wooId) {
            // Se crea sin fotos (es lo rápido) y las fotos se ponen después: si algo tarda, un reintento no duplica el producto.
            const { images: _fotos, ...sinFotos } = plan.producto;
            const creado = await this.api.crearProducto(auth, { ...sinFotos, ...(categoria ? { categories: [{ id: categoria.categoria.id }] } : {}) });
            wooId = creado.id;
            // Un borrador no se puede ver en la tienda: el enlace lleva a su pantalla de edición en WordPress (al publicarlo, la
            // próxima lectura del catálogo lo reemplaza por la dirección pública).
            permalink = `${normalizarSitioWoo(auth.site)}/wp-admin/post.php?post=${creado.id}&action=edit`;
            // Se anota ya en el enlace de cada variante: si algo falla más adelante, el reintento reutiliza este producto.
            for (const p of familia) {
                const base = plan.tipo === 'simple' ? { variationId: null } : {};
                enlaces.set(p.id, await this.guardarEnlace(p, connectionId, enlaces.get(p.id), { externalId: wooId, permalink: permalink as any, syncStatus: 'paused', lastError: null as any, ...base }));
            }
        }

        // Fotos del producto (en uno variable, las de todas sus variantes).
        if (plan.producto.images?.length) await this.api.actualizarProducto(auth, wooId, { images: plan.producto.images });

        let creadas = 0;
        const errores: string[] = [];
        if (plan.tipo === 'simple') {
            const p = familia[0];
            await this.guardarEnlace(p, connectionId, enlaces.get(p.id), this.datosDeEnlace(p, plan.producto.regular_price, plan.producto.sale_price, plan.producto.images?.[0]?.src, null, wooId, permalink));
            creadas = 1;
        } else {
            const existentes = new Map((await this.api.variacionesDe(auth, wooId)).filter((v) => v.sku).map((v) => [clave(v.sku), v.id]));
            const porCrear: typeof plan.variaciones = [];
            for (const v of plan.variaciones) {
                const idExistente = existentes.get(clave(v.sku));
                if (idExistente) {
                    // Ya estaba en WooCommerce (un intento anterior): solo se completa el enlace.
                    await this.completarEnlace(familia.find((p) => p.id === v.productId)!, connectionId, enlaces, v, idExistente, wooId, permalink);
                    creadas++;
                } else porCrear.push(v);
            }
            const resultados = await this.api.crearVariaciones(auth, wooId, porCrear.map((v) => v.body));
            for (let i = 0; i < porCrear.length; i++) {
                const v = porCrear[i];
                const p = familia.find((x) => x.id === v.productId)!;
                const r = resultados[i];
                if (r.id) {
                    await this.completarEnlace(p, connectionId, enlaces, v, r.id, wooId, permalink);
                    creadas++;
                } else {
                    errores.push(`${v.sku}: ${r.error}`);
                    await this.guardarEnlace(p, connectionId, enlaces.get(p.id), { syncStatus: 'error', lastError: String(r.error ?? '').slice(0, 500) });
                }
            }
        }

        if (errores.length) {
            // Falla el trabajo para que la cola reintente solo lo que falta (lo ya creado no se repite).
            throw new Error(`No se pudieron crear ${errores.length} variante(s) en WooCommerce. ${errores[0]}`);
        }
        // Ya tiene todas sus variaciones y sus fotos: ahora sí se publica (salvo que se pida dejarlo en borrador).
        const publicado = process.env.WOO_PUBLICAR_COMO_BORRADOR !== 'true';
        if (publicado) {
            const final = await this.api.actualizarProducto(auth, wooId, { status: 'publish' });
            if (final?.permalink) permalink = final.permalink;
            for (const p of familia) {
                await this.guardarEnlace(p, connectionId, enlaces.get(p.id), { syncStatus: 'published', permalink: permalink as any, lastError: null as any, lastSyncedAt: new Date() });
            }
        }

        const variantes = plan.tipo === 'variable' ? ` (${creadas} variantes)` : '';
        const sinCategoria = 'No se encontró una categoría que encaje: elígela en Synkro o en WordPress (quedó en la categoría por defecto).';
        await this.notifications.notify(userId, {
            type: 'publish',
            severity: 'success',
            title: publicado ? `${familia[0].sku} ya está publicado en WooCommerce` : `${familia[0].sku} está en WooCommerce como borrador`,
            body: `${publicado ? `Ya está a la venta en tu tienda${variantes}.` : `Revísalo en WordPress y publícalo allí${variantes}.`} ${categoria ? `Categoría: ${categoria.categoria.ruta}.` : sinCategoria}`,
            marketplace: MARKETPLACE,
            meta: { productId, connectionId },
        });
        return { externalId: wooId, creadas, publicado };
    }

    private datosDeEnlace(p: Product, regular: string, oferta: string, foto: string | undefined, variationId: string | null, wooId: string, permalink: string | null, variacion?: string): Partial<ListingLink> {
        return {
            externalId: wooId,
            variationId,
            permalink: permalink as any,
            // Mientras se crea queda «pausado» (borrador en WordPress); al terminar pasa a «publicado», salvo que se pida dejarlo en borrador.
            syncStatus: 'paused',
            lastError: null as any,
            lastPriceSynced: Number(regular),
            lastStockSynced: p.stock,
            regularPrice: Number(regular),
            salePrice: oferta ? Number(oferta) : null,
            imageUrl: foto ?? null,
            variation: variacion ?? null,
            parentSku: p.group?.parentSku ?? null,
            lastSyncedAt: new Date(),
        };
    }

    private async completarEnlace(p: Product, connectionId: string, enlaces: Map<string, ListingLink>, v: { body: { regular_price: string; sale_price: string; image?: { src: string }; attributes: { option: string }[] } }, variationId: string, wooId: string, permalink: string | null): Promise<void> {
        const guardado = await this.guardarEnlace(p, connectionId, enlaces.get(p.id), this.datosDeEnlace(p, v.body.regular_price, v.body.sale_price, v.body.image?.src, variationId, wooId, permalink, v.body.attributes.map((a) => a.option).join(' / ')));
        enlaces.set(p.id, guardado);
    }

    private async guardarEnlace(producto: Product, connectionId: string, enlace: ListingLink | undefined, cambios: Partial<ListingLink>): Promise<ListingLink> {
        const base = enlace ?? this.listingLinkRepository.create({ marketplace: MARKETPLACE, product: producto, connection: { id: connectionId } as any });
        // Un enlace cerrado que se vuelve a publicar empieza de cero.
        if (base.syncStatus === 'removed') Object.assign(base, { externalId: '', variationId: null, permalink: null });
        // Un producto que ya está a la venta no pasa a «pausado» mientras se completan sus variaciones.
        if (base.syncStatus === 'published' && cambios.syncStatus === 'paused') cambios = { ...cambios, syncStatus: 'published' };
        Object.assign(base, cambios);
        return this.listingLinkRepository.save(base);
    }

    /** Anota el fallo definitivo de una publicación y avisa a la persona (los reintentos ya se agotaron). */
    async marcarFallida(productId: string, connectionId: string, userId: string, motivo: string): Promise<void> {
        const familia = await this.cargarFamilia(productId).catch(() => [] as Product[]);
        for (const producto of familia) {
            const enlace = await this.listingLinkRepository.findOne({ where: { product: { id: producto.id }, connection: { id: connectionId } } });
            // Lo ya creado en WooCommerce (con su variación) se conserva; solo se marca lo que no llegó.
            if (enlace && enlace.syncStatus !== 'published' && !(enlace.externalId && (enlace.variationId || !producto.group))) {
                await this.guardarEnlace(producto, connectionId, enlace, { syncStatus: 'error', lastError: motivo.slice(0, 500) });
            }
        }
        await this.notifications.notify(userId, {
            type: 'publish-error',
            severity: 'error',
            title: `No se pudo publicar ${familia[0]?.sku ?? productId} en WooCommerce`,
            body: motivo.slice(0, 300),
            marketplace: MARKETPLACE,
            meta: { productId, connectionId },
        });
    }
}

export { PlanInvalido };
