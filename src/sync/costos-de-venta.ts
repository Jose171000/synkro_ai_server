/**
 * Envío y cupones de cada venta, en un formato común a todos los canales.
 *
 *  - shippingPaid: lo que pagó el comprador por el envío (se suma a «todo lo que pagó el cliente»; no es base de comisión).
 *  - shippingSellerCost: lo que te costó a ti el envío, solo cuando el canal lo informa (Mercado Libre: envío gratis para el
 *    comprador). Nulo = no se puede saber (Falabella no lo trae en el pedido).
 *  - shippingType: quién lo pagó: 'comprador', 'gratis' (el comprador no pagó envío), 'retiro' (sin envío) o 'sin_dato'.
 *  - discountAmount: cupones y descuentos que aplicó el canal al comprador.
 *  - discountSellerFunded: la parte de eso que cubre el vendedor, si el canal lo dice.
 */
export type TipoDeEnvio = 'comprador' | 'gratis' | 'retiro' | 'sin_dato';

export interface CostosDeVenta {
    shippingPaid: number;
    shippingSellerCost: number | null;
    shippingType: TipoDeEnvio;
    discountAmount: number;
    discountSellerFunded: number | null;
}

export const SIN_COSTOS: CostosDeVenta = { shippingPaid: 0, shippingSellerCost: null, shippingType: 'sin_dato', discountAmount: 0, discountSellerFunded: null };

export const TIPOS_DE_ENVIO: TipoDeEnvio[] = ['comprador', 'gratis', 'retiro', 'sin_dato'];

const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const minusculas = (v: unknown) => String(v ?? '').toLowerCase();

/**
 * Falabella. El pedido trae el envío que pagó el cliente (ShippingAmount por artículo, ShippingFeeTotal en total). Un retiro en
 * tienda (DeliveryMethod = Collect) no lleva envío. Si algún día el artículo informa un costo de servicio (ShippingServiceCost)
 * y el cliente no pagó envío, se toma como envío cubierto por el vendedor; hoy ese campo llega en 0, así que el costo que te
 * cobra Falabella no se puede medir desde el pedido.
 */
export function costosFalabella(pedido: any, items: any[] | null | undefined): CostosDeVenta {
    const lineas = items ?? [];
    let pagado = lineas.reduce((s, i) => s + num(i?.ShippingAmount), 0);
    if (!(pagado > 0)) pagado = num(pedido?.ShippingFeeTotal);
    const servicio = lineas.reduce((s, i) => s + num(i?.ShippingServiceCost), 0);

    let tipo: TipoDeEnvio = 'sin_dato';
    let costoVendedor: number | null = null;
    if (pagado > 0) {
        tipo = 'comprador';
    } else if (servicio > 0) {
        tipo = 'gratis';
        costoVendedor = r2(servicio);
    } else {
        const metodos = lineas.map(i => minusculas(i?.DeliveryMethod));
        if (metodos.length && metodos.every(m => m.includes('collect'))) tipo = 'retiro';
        else if (metodos.some(m => m.includes('home') || m.includes('deliver'))) tipo = 'gratis';
    }

    // Cupón: lo que el comprador pagó de menos frente al precio del artículo.
    const descuento = lineas.reduce((s, i) => s + Math.max(num(i?.ItemPrice) - num(i?.PaidPrice), 0), 0);
    const cmr = lineas.reduce((s, i) => s + num(i?.VoucherAmountDetails?.CmrDiscount), 0);
    const cubreVendedor = lineas.reduce((s, i) => s + (num(i?.VoucherAmountDetails?.CmrDiscount) * num(i?.VoucherAmountDetails?.CmrDiscountSellerFundedPct)) / 100, 0);

    return {
        shippingPaid: r2(pagado),
        shippingSellerCost: costoVendedor,
        shippingType: tipo,
        discountAmount: r2(descuento),
        // Solo se sabe quién cubre el descuento cuando viene del descuento CMR, que informa el porcentaje del vendedor.
        discountSellerFunded: descuento <= 0 ? 0 : cmr > 0 ? r2(cubreVendedor) : null,
    };
}

/**
 * Mercado Libre. El envío que pagó el comprador va en cada pago (payments[].shipping_cost). Si el envío fue gratis para el
 * comprador, el envío trae `lead_time.cost_type = free` y `lead_time.list_cost` es lo que te cobra Mercado Libre por él
 * (coincide con la línea «Envíos» del detalle de la venta en su panel). El cupón no reduce lo que tú recibes.
 */
export function costosMeli(order: any, shipment?: any | null): CostosDeVenta {
    const pagos: any[] = Array.isArray(order?.payments) ? order.payments : [];
    let pagado = pagos.filter((p) => !/rejected|cancel/i.test(String(p?.status ?? ''))).reduce((s, p) => s + num(p?.shipping_cost), 0);
    // Con más de un pago (un reintento, dos tarjetas) el envío puede venir repetido: no puede pasar de lo pagado por encima de los productos.
    const sobrante = num(order?.paid_amount) - num(order?.total_amount);
    if (pagado > 0 && sobrante > 0 && pagado > sobrante) pagado = sobrante;
    if (!(pagado > 0) && num(order?.paid_amount) > num(order?.total_amount)) pagado = num(order.paid_amount) - num(order.total_amount);

    const plazo = shipment?.lead_time ?? shipment?.shipping_option ?? {};
    const costoComprador = num(plazo?.cost);
    const costoDeLista = num(plazo?.list_cost);
    const gratis = minusculas(plazo?.cost_type) === 'free' || (costoDeLista > 0 && costoComprador === 0);

    let tipo: TipoDeEnvio = 'sin_dato';
    let costoVendedor: number | null = null;
    if (pagado > 0) {
        tipo = 'comprador';
    } else if (gratis) {
        tipo = 'gratis';
        costoVendedor = costoDeLista > 0 ? r2(costoDeLista) : null;
    }

    return {
        shippingPaid: r2(pagado),
        shippingSellerCost: costoVendedor,
        shippingType: tipo,
        discountAmount: r2(num(order?.coupon?.amount)),
        discountSellerFunded: null,
    };
}

/** Venta registrada a mano: lo que se cobró de envío y, aparte, lo que cubriste tú. */
export function costosManual(envioCobrado: number, envioCubierto: number): CostosDeVenta {
    const cobrado = Math.max(num(envioCobrado), 0);
    const cubierto = Math.max(num(envioCubierto), 0);
    return {
        shippingPaid: r2(cobrado),
        shippingSellerCost: cubierto > 0 ? r2(cubierto) : null,
        shippingType: cobrado > 0 ? 'comprador' : cubierto > 0 ? 'gratis' : 'sin_dato',
        discountAmount: 0,
        discountSellerFunded: null,
    };
}
