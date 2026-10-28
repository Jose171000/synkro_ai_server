import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { Product } from '../../products/entities/product.entity';
import { ListingLink } from '../entities/listing-link.entity';
import { MarketplaceOrder } from '../entities/marketplace-order.entity';
import { SyncScope, SyncService } from '../sync.service';
import { YavendioApiService, YavendioProduct } from './yavendio-api.service';
import { CandidatoSynkro, SugerenciaDeVariante, sugerirVinculos } from './yavendio-matching';

const MARKETPLACE = 'yavendio';

export interface VistaPreviaDeImportacion {
    totalVariantes: number;
    yaVinculadas: number;
    coincidenciasSeguras: number;
    coincidenciasPosibles: number;
    sinCoincidencia: number;
    variantes: SugerenciaDeVariante[];
}

export interface ParaVincular {
    productId: string;
    variantId: string;
}

export interface ResultadoDeVinculacion {
    vinculadas: number;
    rechazadas: { variantId: string; motivo: string }[];
    /** Ventas anteriores de esas variantes que ahora quedaron asociadas a su producto. */
    ventasCompletadas: number;
}

/**
 * Trae lo que ya existe en una cuenta de Yavendió y lo vincula a productos de Synkro, sin escribir nada en Yavendió.
 * Yavendió no usa SKU: el vínculo es el id de su producto y de su variante, y lo confirma una persona. Esto solo
 * lee de Yavendió y crea enlaces en Synkro; ni el precio ni la disponibilidad cambian hasta el siguiente envío normal.
 */
@Injectable()
export class YavendioCatalogImportService {
    private readonly logger = new Logger(YavendioCatalogImportService.name);

    constructor(
        @InjectRepository(Product) private readonly productRepository: Repository<Product>,
        @InjectRepository(ListingLink) private readonly listingLinkRepository: Repository<ListingLink>,
        @InjectRepository(MarketplaceOrder) private readonly orderRepository: Repository<MarketplaceOrder>,
        private readonly api: YavendioApiService,
        private readonly sync: SyncService,
    ) { }

    /**
     * Las ventas que ya estaban guardadas con esta variante sin producto quedan asociadas al que se acaba de vincular
     * (su producto y su SKU). Así el historial se corrige solo, sin volver a importar. No toca el stock.
     */
    private async completarVentas(connectionId: string, variantId: string, producto: Product): Promise<number> {
        const ventas = await this.orderRepository.createQueryBuilder('o')
            .where('"o"."connectionId" = :connectionId', { connectionId })
            .andWhere('"o"."items" @> CAST(:fragmento AS jsonb)', { fragmento: JSON.stringify([{ channelVariationId: variantId }]) })
            .getMany();

        let completadas = 0;
        for (const venta of ventas) {
            let cambio = false;
            const items = (venta.items ?? []).map((l: any) => {
                if (String(l?.channelVariationId ?? '') !== variantId || l?.productId) return l;
                cambio = true;
                return { ...l, productId: producto.id, sku: producto.sku };
            });
            if (!cambio) continue;
            await this.orderRepository.update(venta.id, { items: items as any });
            completadas++;
        }
        return completadas;
    }

    private async enlacesVivos(connectionId: string): Promise<ListingLink[]> {
        const todos = await this.listingLinkRepository.find({
            where: { marketplace: MARKETPLACE, connection: { id: connectionId }, syncStatus: Not('removed') },
            relations: { product: true },
        });
        return todos.filter((e) => e.variationId);
    }

    /** Qué hay en Yavendió y con qué producto de Synkro parece corresponder cada variante. */
    async preview(scope: SyncScope, connectionId?: string): Promise<VistaPreviaDeImportacion> {
        const connection = await this.sync.resolveConnection(scope.storeId, MARKETPLACE, connectionId);
        const productosYavendio = await this.api.listProducts(connection.accessToken);

        const productos = await this.productRepository.find({ where: { store: { id: scope.storeId } }, relations: { group: true } });
        const candidatos: CandidatoSynkro[] = productos.map((p) => ({
            id: p.id,
            sku: p.sku,
            name: p.name,
            price: p.price != null ? Number(p.price) : null,
            stock: p.stock != null ? Number(p.stock) : null,
            groupName: p.group?.name ?? null,
            variantValues: p.variantValues ?? null,
        }));

        const vinculos = new Map((await this.enlacesVivos(connection.id)).map((e) => [String(e.variationId), e.product.id]));
        const variantes = sugerirVinculos(productosYavendio, candidatos, vinculos);

        return {
            totalVariantes: variantes.length,
            yaVinculadas: variantes.filter((v) => v.vinculadaA).length,
            coincidenciasSeguras: variantes.filter((v) => v.confianza === 'alta').length,
            coincidenciasPosibles: variantes.filter((v) => v.confianza === 'posible').length,
            sinCoincidencia: variantes.filter((v) => !v.vinculadaA && v.confianza === 'ninguna').length,
            variantes,
        };
    }

    /** Crea los vínculos que la persona confirmó. Cada par se valida por separado: uno rechazado no frena a los demás. */
    async link(scope: SyncScope, connectionId: string | undefined, pares: ParaVincular[]): Promise<ResultadoDeVinculacion> {
        if (!pares?.length) throw new BadRequestException('No hay nada que vincular.');
        const connection = await this.sync.resolveConnection(scope.storeId, MARKETPLACE, connectionId);
        const productosYavendio = await this.api.listProducts(connection.accessToken);

        const variantes = new Map<string, { producto: YavendioProduct; variante: NonNullable<YavendioProduct['variants']>[number] }>();
        for (const producto of productosYavendio) for (const variante of producto.variants ?? []) variantes.set(String(variante.id), { producto, variante });

        const resultado: ResultadoDeVinculacion = { vinculadas: 0, rechazadas: [], ventasCompletadas: 0 };
        const rechazar = (variantId: string, motivo: string) => resultado.rechazadas.push({ variantId, motivo });
        const yaVinculadas = new Map((await this.enlacesVivos(connection.id)).map((e) => [String(e.variationId), e.product.id]));
        const usadosEnEstaLlamada = new Set<string>();

        for (const par of pares) {
            const variantId = String(par.variantId);
            const origen = variantes.get(variantId);
            if (!origen) { rechazar(variantId, 'Esa variante ya no existe en Yavendió.'); continue; }
            if (yaVinculadas.has(variantId) || usadosEnEstaLlamada.has(variantId)) { rechazar(variantId, 'Esa variante ya está vinculada a un producto de Synkro.'); continue; }

            let producto: Product;
            try {
                await this.sync.findScopedProduct(scope, par.productId);
                producto = (await this.productRepository.findOne({ where: { id: par.productId }, relations: { group: true } }))!;
            } catch {
                rechazar(variantId, 'El producto de Synkro no existe o no es de esta tienda.');
                continue;
            }

            const existente = await this.listingLinkRepository.findOne({ where: { product: { id: producto.id }, connection: { id: connection.id } } });
            if (existente && existente.syncStatus !== 'removed' && existente.externalId && existente.variationId) {
                rechazar(variantId, `${producto.sku} ya está vinculado a otra variante de esta cuenta de Yavendió.`);
                continue;
            }

            const precio = origen.variante.base_price != null && origen.variante.base_price !== '' ? Number(origen.variante.base_price) : null;
            const enlace = existente ?? this.listingLinkRepository.create({ marketplace: MARKETPLACE, product: producto, connection: { id: connection.id } as any });
            Object.assign(enlace, {
                marketplace: MARKETPLACE,
                externalId: String(origen.producto.id),
                variationId: variantId,
                permalink: null,
                syncStatus: 'published',
                pausedByUser: false,
                lastError: null,
                // El stock queda «sin definir»: Yavendió no lo informa y no se inventa un número.
                lastStockSynced: null,
                lastPriceSynced: null,
                regularPrice: precio !== null && Number.isFinite(precio) ? precio : null,
                imageUrl: origen.variante.media?.find((m) => m.url)?.url ?? null,
                variation: origen.variante.name,
                parentSku: producto.group?.parentSku ?? null,
                lastSyncedAt: new Date(),
            });
            await this.listingLinkRepository.save(enlace);
            usadosEnEstaLlamada.add(variantId);
            resultado.vinculadas++;
            resultado.ventasCompletadas += await this.completarVentas(connection.id, variantId, producto);
        }

        this.logger.log(`Vinculación con Yavendió: ${resultado.vinculadas} vinculadas, ${resultado.rechazadas.length} rechazadas, ${resultado.ventasCompletadas} ventas completadas.`);
        return resultado;
    }
}
