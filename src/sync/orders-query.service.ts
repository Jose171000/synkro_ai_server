import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { ListingLink } from './entities/listing-link.entity';
import { MarketplaceOrder } from './entities/marketplace-order.entity';
import { Product } from '../products/entities/product.entity';
import { StoreRole } from '../stores/entities/store-member.entity';
import { OrderDetails, OrderLine, ocultarContacto } from './order-details';

export interface OrdersQuery {
    from?: string;
    to?: string;
    marketplace?: string;
    connectionId?: string;
    search?: string;
    limit?: number;
    offset?: number;
}

/** Una línea de venta lista para mostrar: con su foto y el stock de ahora. */
export interface OrderLineView extends OrderLine {
    currentStock: number | null;
    imageUrl: string | null;
    productName: string | null;
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIMITE = 200;

/**
 * Lectura de las ventas de una tienda para la pantalla «Ventas»: cada venta
 * con su cliente, su fecha límite de envío, lo que pagó el cliente y, por
 * línea, el stock de después de la venta, el stock de ahora y la foto.
 *
 * Quien solo tiene permiso de lectura ve las ventas pero no los datos de
 * contacto de quien compró (teléfono, correo, documento, dirección).
 */
@Injectable()
export class OrdersQueryService {
    constructor(
        @InjectRepository(MarketplaceOrder) private readonly orders: Repository<MarketplaceOrder>,
        @InjectRepository(Product) private readonly products: Repository<Product>,
        @InjectRepository(ListingLink) private readonly links: Repository<ListingLink>,
    ) { }

    async list(storeId: string, role: StoreRole, query: OrdersQuery) {
        const hoy = new Date();
        const hasta = query.to ?? new Date(hoy.getTime() + 86_400_000).toISOString().slice(0, 10);
        const desde = query.from ?? new Date(hoy.getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
        if (!FECHA.test(desde) || !FECHA.test(hasta)) {
            throw new BadRequestException('Las fechas deben tener el formato AAAA-MM-DD.');
        }
        const limit = Math.min(Math.max(Number(query.limit) || 50, 1), MAX_LIMITE);
        const offset = Math.max(Number(query.offset) || 0, 0);

        const qb = this.orders.createQueryBuilder('o')
            .leftJoinAndSelect('o.connection', 'c')
            .leftJoin('o.owner', 'ow')
            .addSelect('ow.id')
            .where('o."storeId" = :storeId', { storeId })
            .andWhere('o."orderDate"::date BETWEEN :desde AND :hasta', { desde, hasta });

        if (query.marketplace) qb.andWhere('o.marketplace = :marketplace', { marketplace: query.marketplace });
        if (query.connectionId) qb.andWhere('o."connectionId" = :connectionId', { connectionId: query.connectionId });

        const texto = (query.search ?? '').trim();
        if (texto) {
            // Busca por cliente, número de pedido, y por SKU o nombre de cualquier línea.
            qb.andWhere(
                `(o."customerName" ILIKE :q OR o."orderNumber" ILIKE :q OR o."externalId" ILIKE :q OR o.items::text ILIKE :q)`,
                { q: `%${texto.replace(/[%_]/g, m => `\\${m}`)}%` },
            );
        }

        const [filas, total] = await qb
            .orderBy('o.orderDate', 'DESC')
            .addOrderBy('o.id', 'ASC')
            .take(limit)
            .skip(offset)
            .getManyAndCount();

        const vista = await this.enriquecer(storeId, filas);
        return {
            total,
            limit,
            offset,
            items: filas.map(o => this.aVista(o, vista, role, false)),
        };
    }

    async detail(storeId: string, role: StoreRole, id: string) {
        if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('Venta no encontrada');
        const orden = await this.orders.createQueryBuilder('o')
            .leftJoinAndSelect('o.connection', 'c')
            .leftJoin('o.owner', 'ow')
            .addSelect('ow.id')
            .where('o.id = :id AND o."storeId" = :storeId', { id, storeId })
            .getOne();
        if (!orden) throw new NotFoundException('Venta no encontrada');
        const vista = await this.enriquecer(storeId, [orden]);
        return this.aVista(orden, vista, role, true);
    }

    /** Productos de la tienda por SKU: su stock de ahora y su foto. */
    private async enriquecer(storeId: string, filas: MarketplaceOrder[]) {
        const skus = [...new Set(
            filas.flatMap(o => (Array.isArray(o.items) ? o.items : []).map((l: OrderLine) => l?.sku).filter(Boolean) as string[]),
        )];
        const porSku = new Map<string, { productId: string; name: string; stock: number; imageUrl: string | null }>();
        if (!skus.length) return porSku;

        const owners = [...new Set(filas.map(o => (o as any).owner?.id).filter(Boolean))];
        const productos = await this.products.find({
            where: [
                { sku: In(skus), store: { id: storeId } },
                ...(owners.length ? [{ sku: In(skus), store: IsNull(), owner: { id: In(owners) } }] : []),
            ] as any,
        });

        const enlaces = productos.length
            ? await this.links.find({
                where: { product: { id: In(productos.map(p => p.id)) } },
                relations: { product: true },
            })
            : [];
        const fotoDeEnlace = new Map<string, string>();
        for (const e of enlaces) {
            if (e.imageUrl && !fotoDeEnlace.has(e.product.id)) fotoDeEnlace.set(e.product.id, e.imageUrl);
        }

        for (const p of productos) {
            porSku.set(p.sku, {
                productId: p.id,
                name: p.name,
                stock: p.stock,
                imageUrl: p.images?.[0]?.url ?? fotoDeEnlace.get(p.id) ?? null,
            });
        }
        return porSku;
    }

    private aVista(
        o: MarketplaceOrder,
        productos: Map<string, { productId: string; name: string; stock: number; imageUrl: string | null }>,
        role: StoreRole,
        conDetalle: boolean,
    ) {
        const lines: OrderLineView[] = (Array.isArray(o.items) ? o.items : []).map((l: OrderLine) => {
            const p = l?.sku ? productos.get(l.sku) : undefined;
            return {
                ...l,
                quantity: Number(l?.quantity ?? 1),
                unitPrice: Number(l?.unitPrice ?? 0),
                productId: l?.productId ?? p?.productId ?? null,
                stockBefore: l?.stockBefore ?? null,
                stockAfter: l?.stockAfter ?? null,
                currentStock: p ? p.stock : null,
                imageUrl: p?.imageUrl ?? null,
                productName: p?.name ?? null,
            };
        });

        const detalles: OrderDetails | null = o.details ?? null;
        const visibles = role === 'viewer' ? ocultarContacto(detalles) : detalles;

        return {
            id: o.id,
            marketplace: o.marketplace,
            externalId: o.externalId,
            orderNumber: o.orderNumber ?? o.externalId,
            account: o.connection
                ? { id: o.connection.id, label: o.connection.label || o.connection.externalNickname || o.connection.externalUserId }
                : null,
            orderDate: o.orderDate,
            status: o.status,
            customerName: o.customerName,
            shipByDate: o.shipByDate,
            totalAmount: Number(o.totalAmount),
            currency: o.currency,
            itemsCount: o.itemsCount,
            shipping: visibles ? { status: visibles.shipping.status, method: visibles.shipping.method } : null,
            lines,
            ...(conDetalle ? { details: visibles } : {}),
        };
    }
}
