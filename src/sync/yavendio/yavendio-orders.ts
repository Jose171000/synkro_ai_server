import { desfasePorMoneda, fechaFalabella, importeDeProductos, NormalizedOrder, OrderLine } from '../order-details';

/** Pedido de Yavendió tal como lo devuelve GET /orders/:id. */
export interface YavendioOrderDetail {
    id: number;
    order_date: string;
    status?: string | null;
    payment_terms?: string | null;
    payment_method?: string | null;
    currency?: string | null;
    total_amount?: string | number | null;
    pending_amount?: string | number | null;
    delivery_fee?: string | number | null;
    customer?: { name?: string | null; phone_number?: string | null; document_type?: string | null; document_number?: string | null } | null;
    address?: { full_address?: string | null; country?: string | null; state?: string | null; city?: string | null; district?: string | null } | null;
    items?: { variant_id?: number | null; sku?: string | null; name: string; quantity: number; base_price: string | number }[] | null;
    summary_conversation?: string | null;
}

/**
 * Estados que cuentan como venta. «pending» aún no se confirmó; «rejected» y «cancelled» ya no son una venta.
 * Los reportes suman todo lo que haya en la tabla de ventas, así que solo entra lo que de verdad se vendió.
 */
const ESTADOS_DE_VENTA = new Set(['confirmed', 'preparing', 'ready_for_dispatch', 'dispatched', 'delivered', 'completed']);
const ESTADOS_ANULADOS = new Set(['cancelled', 'rejected']);

export type SituacionDelPedido = 'venta' | 'anulado' | 'pendiente';

export function situacionDelPedido(status?: string | null): SituacionDelPedido {
    const s = String(status ?? '').trim().toLowerCase();
    if (ESTADOS_DE_VENTA.has(s)) return 'venta';
    if (ESTADOS_ANULADOS.has(s)) return 'anulado';
    return 'pendiente';
}

const texto = (v: any): string | null => {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s ? s : null;
};
const numero = (v: any): number | null => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

export interface PedidoYavendioNormalizado {
    externalId: string;
    status: string;
    situacion: SituacionDelPedido;
    totalAmount: number;
    currency: string | null;
    orderDate: Date;
    normalized: NormalizedOrder;
}

/**
 * Pasa un pedido de Yavendió al formato común de todos los canales. Cada línea guarda el id de variante de Yavendió
 * (`channelVariationId`): con él se sabe exactamente qué producto de Synkro se vendió, sin adivinar por el nombre.
 */
export function normalizarPedidoYavendio(pedido: YavendioOrderDetail): PedidoYavendioNormalizado {
    const status = String(pedido.status ?? '').trim().toLowerCase();
    const fecha = fechaFalabella(pedido.order_date, desfasePorMoneda(pedido.currency)) ?? new Date();
    const cliente = pedido.customer ?? {};
    const direccion = pedido.address ?? null;
    const total = numero(pedido.total_amount) ?? 0;
    const pendiente = numero(pedido.pending_amount);
    const entrega = numero(pedido.delivery_fee);
    const documento = [texto(cliente.document_type), texto(cliente.document_number)].filter(Boolean).join(' ') || null;

    const lines: OrderLine[] = (pedido.items ?? []).map((i) => ({
        sku: texto(i.sku),
        title: texto(i.name) ?? 'Producto',
        quantity: numero(i.quantity) ?? 1,
        unitPrice: numero(i.base_price) ?? 0,
        listPrice: null,
        channelItemId: null,
        channelVariationId: i.variant_id != null ? String(i.variant_id) : null,
    }));

    const pagado = pendiente !== null ? Math.max(0, total - pendiente) : total;
    return {
        externalId: String(pedido.id),
        status,
        situacion: situacionDelPedido(status),
        totalAmount: total,
        currency: texto(pedido.currency),
        orderDate: fecha,
        normalized: {
            orderNumber: String(pedido.id),
            customerName: texto(cliente.name),
            shipByDate: null,
            lines,
            details: {
                customer: { name: texto(cliente.name), email: null, phone: texto(cliente.phone_number), document: documento, nickname: null },
                shipping: {
                    method: entrega !== null ? `Envío ${entrega.toFixed(2)}` : null,
                    status: status || null,
                    trackingCode: null,
                    carrier: null,
                    shipBy: null,
                    deliveryBy: null,
                    address: {
                        line: texto(direccion?.full_address),
                        city: texto(direccion?.city) ?? texto(direccion?.district),
                        region: texto(direccion?.state),
                        country: texto(direccion?.country),
                        postalCode: null,
                        receiver: texto(cliente.name),
                        notes: null,
                    },
                },
                payment: {
                    method: texto(pedido.payment_method),
                    status: texto(pedido.payment_terms),
                    paidAmount: pagado,
                    installments: null,
                    approvedAt: null,
                },
                notes: texto(pedido.summary_conversation),
                channelStatus: status || null,
            },
        },
    };
}

/** Lo que pagó el cliente solo por los productos (sin el costo de envío): la base de la comisión. */
export function importeProductosYavendio(p: PedidoYavendioNormalizado): number {
    return importeDeProductos(p.normalized.lines, p.totalAmount);
}
