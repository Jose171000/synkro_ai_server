import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { ListingLink } from './entities/listing-link.entity';
import { FalabellaApiService } from './falabella/falabella-api.service';
import { SyncScope, SyncService } from './sync.service';
import { categoriasAsignadas, datosQueFaltan, estadoDeCanal, nombreDeCanal } from '../products/completitud';

export interface ResumenDeProducto {
    categories: {
        falabella: { id: string; path: string | null } | null;
        mercadolibre: { id: string } | null;
        internal: string | null;
    };
    channels: {
        linkId: string;
        marketplace: string;
        channel: string;
        account: string | null;
        /** published | pending | paused | error | removed (una pausa del usuario cuenta como paused). */
        status: string;
        statusLabel: string;
        error: string | null;
        permalink: string | null;
    }[];
    completeness: {
        ready: boolean;
        /** Lo básico que falta para publicar en cualquier canal. */
        missing: string[];
        /** Lo que falta específicamente para un canal, con las mismas reglas con las que se publica. */
        byChannel: Record<string, { ready: boolean; missing: string[] }>;
    };
}

export const MAX_PRODUCTOS_POR_CONSULTA = 100;

/**
 * Lo que la lista de productos muestra de cada uno: la categoría real que tiene en cada canal, el estado real de cada
 * publicación y qué le falta para poder publicarse (con las mismas reglas que se aplican al publicar, no una copia).
 */
@Injectable()
export class ProductOverviewService {
    private readonly logger = new Logger(ProductOverviewService.name);

    constructor(
        @InjectRepository(Product) private readonly productRepository: Repository<Product>,
        @InjectRepository(ListingLink) private readonly listingLinkRepository: Repository<ListingLink>,
        private readonly sync: SyncService,
        private readonly falabellaApi: FalabellaApiService,
    ) { }

    async obtener(scope: SyncScope, ids: string[]): Promise<Record<string, ResumenDeProducto>> {
        const unicos = [...new Set(ids.filter(Boolean))].slice(0, MAX_PRODUCTOS_POR_CONSULTA);
        if (!unicos.length) return {};

        const productos = await this.productRepository.find({
            where: [
                { id: In(unicos), store: { id: scope.storeId } },
                { id: In(unicos), store: IsNull(), owner: { id: scope.userId } },
            ],
        });
        if (!productos.length) return {};

        const enlaces = await this.listingLinkRepository.find({
            where: { product: { id: In(productos.map((p) => p.id)) } },
            relations: { product: true, connection: true },
        });
        const porProducto = new Map<string, ListingLink[]>();
        for (const e of enlaces) porProducto.set(e.product.id, [...(porProducto.get(e.product.id) ?? []), e]);

        // Falabella: credenciales y árbol de categorías (en caché) una sola vez para toda la página.
        const credenciales = await this.sync.resolveConnection(scope.storeId, 'falabella')
            .then((c) => this.sync.credentialsOf(c))
            .catch(() => null);
        const rutas = new Map<string, string>();
        if (credenciales && productos.some((p) => categoriasAsignadas(p).falabella)) {
            for (const c of await this.falabellaApi.getCategories(credenciales).catch(() => [])) rutas.set(String(c.id), c.path);
        }

        const salida: Record<string, ResumenDeProducto> = {};
        for (const p of productos) {
            const links = porProducto.get(p.id) ?? [];
            const cats = categoriasAsignadas(p);
            const missing = datosQueFaltan(p);
            const byChannel: Record<string, { ready: boolean; missing: string[] }> = {};

            const apuntaAFalabella = links.some((l) => l.marketplace === 'falabella' && l.syncStatus !== 'removed') || (p.targetMarketplaces ?? []).includes('falabella');
            if (apuntaAFalabella) {
                const f = await this.faltaEnFalabella(p, cats.falabella, credenciales);
                byChannel.falabella = { ready: f.length === 0, missing: f };
            }

            salida[p.id] = {
                categories: {
                    falabella: cats.falabella ? { id: cats.falabella, path: rutas.get(cats.falabella) ?? null } : null,
                    mercadolibre: cats.mercadolibre ? { id: cats.mercadolibre } : null,
                    internal: cats.interna,
                },
                channels: links
                    .filter((l) => l.syncStatus !== 'removed')
                    .map((l) => ({
                        linkId: l.id,
                        marketplace: l.marketplace,
                        channel: nombreDeCanal(l.marketplace),
                        account: l.connection?.label || l.connection?.externalNickname || null,
                        status: l.pausedByUser && l.syncStatus === 'published' ? 'paused' : l.syncStatus,
                        statusLabel: estadoDeCanal(l),
                        error: l.lastError ?? null,
                        permalink: l.permalink ?? null,
                    })),
                completeness: {
                    ready: missing.length === 0 && Object.values(byChannel).every((c) => c.ready),
                    missing,
                    byChannel,
                },
            };
        }
        return salida;
    }

    /** Lo que le falta a un producto para Falabella: categoría, medidas del paquete y los datos obligatorios de su categoría. */
    private async faltaEnFalabella(p: Product, categoriaId: string | null, credenciales: any): Promise<string[]> {
        const faltan: string[] = [];
        if (!categoriaId) faltan.push('categoría de Falabella');
        const a = (p.aiAttributes as any) || {};
        const mide = (p.packageWidth ?? a.packageWidth) && (p.packageLength ?? a.packageLength) && (p.packageHeight ?? a.packageHeight) && (p.packageWeight ?? a.packageWeight);
        if (!mide) faltan.push('medidas y peso del paquete');
        if (!categoriaId || !mide) return faltan;

        // Con categoría y medidas, las mismas reglas con las que se publica dicen qué datos de la categoría faltan.
        const definiciones = credenciales ? await this.falabellaApi.getCategoryAttributes(credenciales, categoriaId).catch(() => null) : null;
        if (!definiciones) return faltan;
        const resultado = this.sync.toFalabellaInput(p, 'active', definiciones);
        if (!('reason' in resultado)) return faltan;
        const detalle = resultado.reason.match(/en Falabella: (.+)$/);
        if (detalle) faltan.push(...detalle[1].split(', ').map((x) => x.trim()).filter(Boolean));
        else if (!/^no tiene precio/.test(resultado.reason)) faltan.push(resultado.reason);
        return faltan;
    }
}
