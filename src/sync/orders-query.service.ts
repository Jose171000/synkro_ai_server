import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { ListingLink } from './entities/listing-link.entity';
import { MarketplaceOrder } from './entities/marketplace-order.entity';
import { Product } from '../products/entities/product.entity';
import { StoreRole } from '../stores/entities/store-member.entity';
import { OrderDetails, OrderLine, ocultarContacto, textoDeValores, textoDeVariante } from './order-details';
import { ESTADOS_DE_VENTA, EstadoDeVenta } from './estado-de-venta';
import { TIPOS_DE_ENVIO, TipoDeEnvio } from './costos-de-venta';

export interface OrdersQuery {
    from?: string;
    to?: string;
    marketplace?: string;
    connectionId?: string;
    search?: string;
    /** Estados a mostrar, separados por coma: pendiente, enviado, entregado, cancelado, devuelto. Vacío = todos. */
    status?: string;
    /** Cómo se pagó el envío, separados por coma: comprador, gratis, retiro, sin_dato. Vacío = todos. */
    shipping?: string;
    limit?: number;
    offset?: number;
}

/** Una línea de venta lista para mostrar: con su foto y el stock de ahora. */
export interface OrderLineView extends OrderLine {
    currentStock: number | null;
    imageUrl: string | null;
    productName: string | null;
}

/** Una fila por producto vendido de una venta: lo que se descarga en Excel. El envío cobrado va en la primera fila de cada venta. */
export function filasDeExportacion(v: any): Record<string, string | number>[] {
    const fecha = v.orderDate ? new Date(v.orderDate).toISOString().slice(0, 10) : '';
    const limite = v.shipByDate ? new Date(v.shipByDate).toISOString().slice(0, 10) : '';
    const d = v.details;
    const lineas: any[] = v.lines?.length ? v.lines : [{ sku: null, title: 'Sin detalle de productos', quantity: 1, unitPrice: v.totalAmount }];
    return lineas.map((l, i) => ({
        fecha,
        canal: v.marketplace,
        cuenta: v.account?.label ?? '',
        numero_pedido: v.orderNumber ?? '',
        estado: v.saleState ?? '',
        estado_en_el_canal: v.status ?? '',
        cliente: v.customerName ?? '',
        telefono: d?.customer?.phone ?? '',
        documento: d?.customer?.document ?? '',
        direccion: d?.shipping?.address?.line ?? '',
        sku: l.sku ?? '',
        producto: l.productName || l.title || '',
        variante: l.variant ?? '',
        cantidad: Number(l.quantity ?? 1),
        precio_unitario: Number(l.unitPrice ?? 0),
        importe_productos: Math.round(Number(l.quantity ?? 1) * Number(l.unitPrice ?? 0) * 100) / 100,
        envio_cobrado: i === 0 ? Number(v.shippingPaid ?? d?.shippingAmount ?? 0) : 0,
        tipo_de_envio: i === 0 ? (v.shippingType ?? '') : '',
        costo_envio_para_el_vendedor: i === 0 && v.shippingSellerCost != null ? Number(v.shippingSellerCost) : '',
        cupon_o_descuento: i === 0 ? Number(v.discountAmount ?? 0) : 0,
        total_del_pedido: i === 0 ? Number(v.totalAmount ?? 0) : 0,
        moneda: v.currency ?? '',
        enviar_antes_de: limite,
        stock_tras_la_venta: l.stockAfter ?? '',
        stock_actual: l.currentStock ?? '',
    }));
}

/** Lo que el formulario necesita para editar una venta manual, en el mismo formato con que se registró. */
export function datosParaEditar(o: any, lines: any[]) {
    const d = o.details ?? {};
    return {
        canal: o.marketplace,
        // Fecha de la venta en Lima: se guarda a mediodía de ese día.
        fecha: new Date(new Date(o.orderDate).getTime() - 5 * 3600_000).toISOString().slice(0, 10),
        numeroPedido: o.orderNumber ?? '',
        estado: o.saleState,
        envio: Number(d.shippingAmount ?? 0),
        envioCubierto: Number(d.shippingSellerCost ?? 0),
        cliente: o.customerName ?? '',
        telefono: d.customer?.phone ?? '',
        documento: d.customer?.document ?? '',
        direccion: d.shipping?.address?.line ?? '',
        notas: d.notes ?? '',
        moneda: o.currency,
        lineas: lines.map(l => ({
            sku: l.sku ?? '',
            cantidad: Number(l.quantity ?? 1),
            precio: Number(l.unitPrice ?? 0),
            // Si la venta descontó stock, esa línea tiene «stock antes» anotado.
            descontar: l.stockBefore != null,
            producto: { sku: l.sku ?? '', name: l.productName || l.title, variant: l.variant ?? null, price: Number(l.unitPrice ?? 0), stock: l.currentStock ?? 0, imageUrl: l.imageUrl ?? null },
        })),
    };
}

/** Tipos de envío pedidos en la consulta, sin repetidos y solo los que existen. */
export function tiposDeEnvioPedidos(texto?: string): TipoDeEnvio[] {
    const pedidos = String(texto ?? '').toLowerCase().split(',').map(e => e.trim());
    return TIPOS_DE_ENVIO.filter(e => pedidos.includes(e));
}

/** Estados pedidos en la consulta, sin repetidos y solo los que existen. */
export function estadosPedidos(texto?: string): EstadoDeVenta[] {
    const pedidos = String(texto ?? '').toLowerCase().split(',').map(e => e.trim());
    return ESTADOS_DE_VENTA.filter(e => pedidos.includes(e));
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIMITE = 200;
/** Tope de ventas por descarga. */
const MAX_EXPORTADAS = 5000;

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

    /** Las ventas de la tienda con los filtros de la pantalla (fechas, canal, cuenta, búsqueda), sin el de estado. */
    private filtrar(storeId: string, query: OrdersQuery) {
        const hoy = new Date();
        const hasta = query.to ?? new Date(hoy.getTime() + 86_400_000).toISOString().slice(0, 10);
        const desde = query.from ?? new Date(hoy.getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
        if (!FECHA.test(desde) || !FECHA.test(hasta)) {
            throw new BadRequestException('Las fechas deben tener el formato AAAA-MM-DD.');
        }

        const qb = this.orders.createQueryBuilder('o')
            .leftJoinAndSelect('o.connection', 'c')
            .leftJoin('o.owner', 'ow')
            .addSelect('ow.id')
            .where('o."storeId" = :storeId', { storeId })
            // El día de una venta es el de Lima (la base de datos va en hora universal).
            .andWhere('(o."orderDate" AT TIME ZONE \'America/Lima\')::date BETWEEN :desde AND :hasta', { desde, hasta });

        if (query.marketplace) qb.andWhere('o.marketplace = :marketplace', { marketplace: query.marketplace });
        if (query.connectionId) qb.andWhere('o."connectionId" = :connectionId', { connectionId: query.connectionId });

        const tiposDeEnvio = tiposDeEnvioPedidos(query.shipping);
        if (tiposDeEnvio.length) qb.andWhere('o."shippingType" IN (:...tiposDeEnvio)', { tiposDeEnvio });

        const texto = (query.search ?? '').trim();
        if (texto) {
            // Busca por cliente, número de pedido, y por SKU o nombre de cualquier línea.
            qb.andWhere(
                `(o."customerName" ILIKE :q OR o."orderNumber" ILIKE :q OR o."externalId" ILIKE :q OR o.items::text ILIKE :q)`,
                { q: `%${texto.replace(/[%_]/g, m => `\\${m}`)}%` },
            );
        }
        return { qb, desde, hasta };
    }

    async list(storeId: string, role: StoreRole, query: OrdersQuery) {
        const limit = Math.min(Math.max(Number(query.limit) || 50, 1), MAX_LIMITE);
        const offset = Math.max(Number(query.offset) || 0, 0);
        const { qb } = this.filtrar(storeId, query);

        // Cuántas ventas hay en cada estado con los demás filtros puestos (para mostrar el número en cada opción).
        const porEstado: Record<string, number> = Object.fromEntries(ESTADOS_DE_VENTA.map(e => [e, 0]));
        const conteo = await qb.clone().select('o."saleState"', 'estado').addSelect('COUNT(*)', 'n').groupBy('o."saleState"').getRawMany();
        for (const c of conteo) porEstado[c.estado] = Number(c.n);

        const estados = estadosPedidos(query.status);
        if (estados.length) qb.andWhere('o."saleState" IN (:...estados)', { estados });

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
            porEstado,
            items: filas.map(o => this.aVista(o, vista, role, false)),
        };
    }

    /**
     * Las ventas que coinciden con los filtros, listas para descargar: una fila por producto vendido. Quien solo tiene
     * lectura no recibe los datos de contacto de quien compró. Con un tope, para no armar un archivo gigante.
     */
    async exportar(storeId: string, role: StoreRole, query: OrdersQuery): Promise<{ filas: Record<string, string | number>[]; ventas: number; incompleto: boolean }> {
        const { qb } = this.filtrar(storeId, query);
        const estados = estadosPedidos(query.status);
        if (estados.length) qb.andWhere('o."saleState" IN (:...estados)', { estados });
        const todas = await qb.orderBy('o.orderDate', 'DESC').addOrderBy('o.id', 'ASC').take(MAX_EXPORTADAS + 1).getMany();
        const incompleto = todas.length > MAX_EXPORTADAS;
        const filasDb = todas.slice(0, MAX_EXPORTADAS);
        const vista = await this.enriquecer(storeId, filasDb);
        const filas = filasDb.flatMap(o => filasDeExportacion(this.aVista(o, vista, role, true)));
        return { filas, ventas: filasDb.length, incompleto };
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
        const porSku = new Map<string, { productId: string; name: string; stock: number; imageUrl: string | null; variant: string | null }>();
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
                variant: textoDeValores(p.variantValues),
            });
        }
        return porSku;
    }

    private aVista(
        o: MarketplaceOrder,
        productos: Map<string, { productId: string; name: string; stock: number; imageUrl: string | null; variant: string | null }>,
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
                // La variante del catálogo manda (es la misma venga de donde venga la venta); si no está, la que dijo el canal.
                // Las ventas guardadas antes de este arreglo pueden traer el JSON crudo de Falabella: se limpia al mostrarlas.
                variant: p?.variant ?? textoDeVariante(l?.variant),
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
            /** Registrada a mano o desde Excel: es la única que se puede editar o eliminar. */
            manual: !!(o.details as any)?.manual,
            saleState: o.saleState,
            shippingPaid: Number(o.shippingPaid ?? 0),
            shippingSellerCost: o.shippingSellerCost != null ? Number(o.shippingSellerCost) : null,
            shippingType: o.shippingType ?? 'sin_dato',
            discountAmount: Number(o.discountAmount ?? 0),
            discountSellerFunded: o.discountSellerFunded != null ? Number(o.discountSellerFunded) : null,
            customerName: o.customerName,
            shipByDate: o.shipByDate,
            totalAmount: Number(o.totalAmount),
            currency: o.currency,
            itemsCount: o.itemsCount,
            shipping: visibles ? { status: visibles.shipping.status, method: visibles.shipping.method } : null,
            lines,
            ...(conDetalle ? { details: visibles } : {}),
            // Solo quien puede editarla recibe los datos para precargar el formulario.
            ...(conDetalle && role === 'owner' && (o.details as any)?.manual ? { manualEdit: datosParaEditar(o, lines) } : {}),
        };
    }
}
