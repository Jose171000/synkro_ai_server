import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { In, IsNull, Raw, Repository } from 'typeorm';
import { MarketplaceOrder } from './entities/marketplace-order.entity';
import { MarketplaceConnection } from './entities/marketplace-connection.entity';
import { ListingLink } from './entities/listing-link.entity';
import { Product } from '../products/entities/product.entity';
import { LineaManual, VentaManual, nombreDeCanalManual, ventasDeFilas } from './ventas-manuales';
import { textoDeValores } from './order-details';
import { OrderLine } from './order-details';
import { leerPrimeraHoja } from '../common/excel/excel';
import { hoyEnLima } from '../admin/plan-comercial';

export interface ResultadoManual {
    registradas: number;
    /** Una línea por venta o fila que no se registró, con el motivo. */
    rechazadas: string[];
}

/** Canales que Synkro trae solo: sus ventas no se registran a mano para no duplicarlas. */
const CANALES_CONECTABLES = ['mercadolibre', 'falabella', 'yavendio', 'woocommerce', 'shopify'];

/**
 * Registro de ventas de canales que la tienda no tiene conectados. Cada venta queda como cualquier otra (cuenta en
 * Ventas, Analíticas y el cobro) y, si se pide, descuenta el stock y lo avisa a los canales conectados.
 */
@Injectable()
export class ManualSalesService {
    constructor(
        @InjectRepository(MarketplaceOrder) private readonly orders: Repository<MarketplaceOrder>,
        @InjectRepository(MarketplaceConnection) private readonly connections: Repository<MarketplaceConnection>,
        @InjectRepository(Product) private readonly products: Repository<Product>,
        @InjectRepository(ListingLink) private readonly links: Repository<ListingLink>,
        @InjectQueue('marketplace-sync-queue') private readonly syncQueue: Queue,
    ) { }

    /** Productos del catálogo que coinciden con lo escrito (SKU o nombre), para elegir el de la venta. El SKU exacto va primero. */
    async buscarProductos(scope: { userId: string; storeId: string }, texto: string) {
        const q = String(texto ?? '').trim();
        if (!q) return [];
        const patron = `%${q.replace(/[%_\\]/g, m => `\\${m}`)}%`;
        const productos = await this.products.createQueryBuilder('p')
            .where('(p."storeId" = :storeId OR (p."storeId" IS NULL AND p."ownerId" = :userId))', { storeId: scope.storeId, userId: scope.userId })
            .andWhere('(p.sku ILIKE :patron OR p.name ILIKE :patron)', { patron })
            .orderBy('(LOWER(p.sku) = LOWER(:exacto))', 'DESC')
            .addOrderBy('p.sku', 'ASC')
            .setParameter('exacto', q)
            .take(8)
            .getMany();
        return productos.map(p => ({
            sku: p.sku,
            name: p.name,
            variant: textoDeValores(p.variantValues),
            price: p.price != null ? Number(p.price) : null,
            stock: p.stock,
            imageUrl: p.images?.[0]?.url ?? null,
        }));
    }

    /** Lee un Excel con la plantilla y registra sus ventas. */
    async importarExcel(scope: { userId: string; storeId: string }, buffer: Buffer): Promise<ResultadoManual> {
        let filas: Record<string, any>[];
        try {
            filas = await leerPrimeraHoja(buffer);
        } catch {
            throw new BadRequestException('No se pudo leer el archivo. Usa la plantilla de ventas en formato .xlsx.');
        }
        if (!filas.length) throw new BadRequestException('El archivo no tiene filas de ventas.');
        const { ventas, errores } = ventasDeFilas(filas);
        const r = await this.registrar(scope, ventas);
        return { registradas: r.registradas, rechazadas: [...errores, ...r.rechazadas] };
    }

    async registrar(scope: { userId: string; storeId: string }, ventas: VentaManual[]): Promise<ResultadoManual> {
        const conectados = new Set((await this.connections.find({ where: { store: { id: scope.storeId }, status: 'active' } })).map(c => c.marketplace));
        let registradas = 0;
        const rechazadas: string[] = [];
        for (const v of ventas) {
            const etiqueta = v.numeroPedido ? `Pedido ${v.numeroPedido}` : `Venta de ${v.cliente ?? 'sin cliente'} (${v.lineas[0]?.sku})`;
            if (CANALES_CONECTABLES.includes(v.canal) && conectados.has(v.canal)) {
                rechazadas.push(`${etiqueta}: ${nombreDeCanalManual(v.canal)} está conectado, sus ventas entran solas.`);
                continue;
            }
            try {
                const motivo = await this.registrarUna(scope, v);
                if (motivo) rechazadas.push(`${etiqueta}: ${motivo}`); else registradas++;
            } catch (error: any) {
                rechazadas.push(`${etiqueta}: ${error?.message ?? 'no se pudo registrar'}`);
            }
        }
        return { registradas, rechazadas };
    }

    /** Devuelve el motivo si no se registró. */
    private async registrarUna(scope: { userId: string; storeId: string }, v: VentaManual): Promise<string | null> {
        if (!v.lineas.length) return 'no tiene productos.';
        // Una venta con fecha de mañana no aparecería en las listas hasta entonces: se pide corregirla.
        if (v.fecha && v.fecha > hoyEnLima()) return `la fecha ${v.fecha} es futura; usa hoy (${hoyEnLima()}) o una anterior.`;
        const externalId = v.numeroPedido ? `MAN-${v.canal}-${v.numeroPedido}` : `MAN-${v.canal}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
        if (v.numeroPedido && await this.orders.findOne({ where: { marketplace: v.canal, externalId } })) return 'ya está registrado.';

        const armadas = await this.armarLineas(scope, v.lineas);
        if ('motivo' in armadas) return armadas.motivo;
        const lineas = armadas.lineas;
        const cuenta = v.estado !== 'cancelado' && v.estado !== 'devuelto';
        const productos = lineas.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
        const redondo = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
        const iso = v.fecha ?? hoyEnLima();

        const guardada = await this.orders.save(this.orders.create({
            marketplace: v.canal,
            externalId,
            owner: { id: scope.userId } as any,
            store: { id: scope.storeId } as any,
            connection: null,
            totalAmount: redondo(productos + v.envio),
            productsAmount: redondo(productos),
            currency: v.moneda,
            itemsCount: lineas.reduce((s, l) => s + l.quantity, 0) || 1,
            items: lineas as any,
            status: v.estado,
            saleState: v.estado,
            orderNumber: v.numeroPedido,
            customerName: v.cliente,
            shipByDate: null,
            details: {
                customer: { name: v.cliente, email: null, phone: v.telefono, document: v.documento },
                shipping: {
                    method: null, status: v.estado, trackingCode: null, carrier: null, shipBy: null, deliveryBy: null,
                    address: { line: v.direccion, city: null, region: null, country: null, postalCode: null, receiver: v.cliente, notes: null },
                },
                payment: { method: null, status: null, paidAmount: redondo(productos + v.envio), installments: null, approvedAt: null },
                notes: v.notas,
                channelStatus: v.estado,
                manual: true,
                shippingAmount: v.envio,
            } as any,
            // Mediodía de Lima: el día no cambia con el huso horario al mostrarlo ni al agrupar por día.
            orderDate: new Date(`${iso}T12:00:00-05:00`),
        }));

        if (cuenta) await this.descontarStock(scope, guardada, lineas, v.lineas);
        return null;
    }

    /**
     * Cada línea con su producto del catálogo, identificado solo por el SKU (sin distinguir mayúsculas). Un SKU que no está
     * en el catálogo de la tienda impide registrar la venta; sin precio escrito se usa el actual del producto.
     */
    private async armarLineas(scope: { userId: string; storeId: string }, entrada: LineaManual[]): Promise<{ lineas: OrderLine[] } | { motivo: string }> {
        const skus = [...new Set(entrada.map(l => l.sku.toLowerCase()))];
        const productos = await this.products.find({
            where: [
                { sku: Raw(a => `LOWER(${a}) IN (:...skus)`, { skus }), store: { id: scope.storeId } },
                { sku: Raw(a => `LOWER(${a}) IN (:...skus)`, { skus }), store: IsNull(), owner: { id: scope.userId } },
            ],
        });
        const porSku = new Map(productos.map(p => [p.sku.toLowerCase(), p]));
        const faltan = skus.filter(s => !porSku.has(s));
        if (faltan.length) {
            const originales = entrada.filter(l => faltan.includes(l.sku.toLowerCase())).map(l => l.sku);
            return { motivo: `el SKU ${[...new Set(originales)].join(', ')} no está en el catálogo de la tienda.` };
        }
        const lineas: OrderLine[] = [];
        for (const l of entrada) {
            const p = porSku.get(l.sku.toLowerCase())!;
            const precio = l.precioUnitario ?? (p.price != null ? Number(p.price) : null);
            if (precio === null || !Number.isFinite(precio)) return { motivo: `el SKU ${p.sku} no tiene precio en el catálogo: escribe el precio_unitario.` };
            lineas.push({ sku: p.sku, title: p.name, quantity: l.cantidad, unitPrice: precio, productId: p.id, variant: textoDeValores(p.variantValues) });
        }
        return { lineas };
    }

    /** Baja el stock de lo vendido (las líneas que lo piden y están en el catálogo) y avisa a los canales conectados. */
    private async descontarStock(scope: { userId: string; storeId: string }, orden: MarketplaceOrder, lineas: OrderLine[], entrada: LineaManual[]) {
        let cambio = false;
        for (let i = 0; i < lineas.length; i++) {
            const l = lineas[i];
            if (!entrada[i].descontarStock || !l.productId) continue;
            const producto = await this.products.findOne({ where: { id: l.productId } });
            if (!producto) continue;
            const antes = producto.stock;
            producto.stock = Math.max(0, antes - l.quantity);
            await this.products.save(producto);
            lineas[i] = { ...l, stockBefore: antes, stockAfter: producto.stock };
            cambio = true;

            const enlaces = await this.links.find({ where: { product: { id: producto.id }, syncStatus: In(['published', 'paused']) }, relations: { connection: true } });
            for (const e of enlaces) {
                if (!e.connection) continue;
                await this.syncQueue.add('inventory', { productId: producto.id, userId: scope.userId, marketplace: e.marketplace, connectionId: e.connection.id });
            }
        }
        if (cambio) await this.orders.update(orden.id, { items: lineas as any });
    }
}
