/**
 * Convierte lo que entrega cada canal sobre una venta en un formato común,
 * para poder mostrarla igual venga de donde venga: quién compró, cuánto pagó,
 * cuándo hay que enviarla, a dónde, y cada línea con su precio.
 *
 * Son funciones puras y tolerantes: los canales no siempre mandan todos los
 * campos (y algunos cambian según el país), así que lo que falta queda en
 * null en vez de romper la sincronización de ventas.
 */

export interface OrderLine {
    sku: string | null;
    title: string;
    quantity: number;
    /** Lo que pagó el cliente por unidad. */
    unitPrice: number;
    /** Precio de lista por unidad, si el canal lo informa (para ver el descuento). */
    listPrice?: number | null;
    shippingAmount?: number | null;
    status?: string | null;
    trackingCode?: string | null;
    carrier?: string | null;
    shippingType?: string | null;
    /** Id de la línea o del ítem en el canal. */
    channelItemId?: string | null;
    /** Variante de la publicación (Mercado Libre), si la hay. */
    channelVariationId?: string | null;
    /** Se completan al descontar el stock de la venta. */
    productId?: string | null;
    stockBefore?: number | null;
    stockAfter?: number | null;
}

export interface OrderDetails {
    customer: {
        name: string | null;
        email: string | null;
        phone: string | null;
        document: string | null;
        nickname?: string | null;
    };
    shipping: {
        method: string | null;
        status: string | null;
        trackingCode: string | null;
        carrier: string | null;
        /** Fecha máxima para despachar. */
        shipBy: string | null;
        /** Fecha estimada de entrega al cliente. */
        deliveryBy: string | null;
        address: {
            line: string | null;
            city: string | null;
            region: string | null;
            country: string | null;
            postalCode: string | null;
            receiver: string | null;
            notes: string | null;
        };
    };
    payment: {
        method: string | null;
        status: string | null;
        paidAmount: number | null;
        installments: number | null;
        approvedAt: string | null;
    };
    notes: string | null;
    channelStatus: string | null;
}

export interface NormalizedOrder {
    orderNumber: string | null;
    customerName: string | null;
    shipByDate: Date | null;
    details: OrderDetails;
    lines: OrderLine[];
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

const unir = (...partes: any[]): string | null => {
    const s = partes.map(texto).filter(Boolean).join(' ').trim();
    return s || null;
};

/**
 * Falabella manda las fechas sin zona horaria («2026-10-12 23:59:59»). Se
 * interpretan en la hora del país: sin esto una fecha límite de «hoy a las
 * 23:59» aparecería como mañana. Perú (-05:00) es el valor por defecto.
 */
export function fechaFalabella(raw: any, desfase = '-05:00'): Date | null {
    const s = texto(raw);
    if (!s) return null;
    const conZona = /(Z|[+-]\d{2}:?\d{2})$/.test(s);
    const iso = s.includes('T') ? s : s.replace(' ', 'T');
    const d = new Date(conZona ? iso : `${iso}${desfase}`);
    return Number.isNaN(d.getTime()) ? null : d;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Desfase horario por moneda: la moneda de la cuenta delata el país del Seller Center. */
export function desfasePorMoneda(currency?: string | null): string {
    switch ((currency || '').toUpperCase()) {
        case 'CLP': return '-03:00';
        case 'COP': return '-05:00';
        default: return '-05:00';
    }
}

// ─────────────────────────────────────────────────────────────
// Falabella
// ─────────────────────────────────────────────────────────────

export function normalizeFalabellaOrder(pedido: any, items: any[], currency?: string | null): NormalizedOrder {
    const desfase = desfasePorMoneda(currency);
    const envio = pedido?.AddressShipping ?? {};
    const facturacion = pedido?.AddressBilling ?? {};

    const nombreCliente =
        unir(pedido?.CustomerFirstName, pedido?.CustomerLastName) ??
        unir(envio?.FirstName, envio?.LastName) ??
        unir(facturacion?.FirstName, facturacion?.LastName);

    const lines: OrderLine[] = (items ?? []).map(i => ({
        sku: texto(i?.Sku),
        title: texto(i?.Name) ?? 'Producto',
        quantity: 1, // Falabella devuelve una línea por unidad vendida
        unitPrice: numero(i?.PaidPrice) ?? numero(i?.ItemPrice) ?? 0,
        listPrice: numero(i?.ItemPrice),
        shippingAmount: numero(i?.ShippingAmount),
        status: texto(i?.Status),
        trackingCode: texto(i?.TrackingCode),
        carrier: texto(i?.ShipmentProvider),
        shippingType: texto(i?.ShippingType),
        channelItemId: texto(i?.OrderItemId),
    }));

    // La fecha límite puede venir en el pedido o solo en sus líneas: gana la más próxima.
    const fechas = [pedido?.PromisedShippingTime, ...(items ?? []).map(i => i?.PromisedShippingTime)]
        .map(f => fechaFalabella(f, desfase))
        .filter((d): d is Date => !!d)
        .sort((a, b) => a.getTime() - b.getTime());
    const shipBy = fechas[0] ?? null;

    const direccion = unir(envio?.Address1, envio?.Address2, envio?.Address3, envio?.Address4, envio?.Address5);
    const rastreo = lines.find(l => l.trackingCode)?.trackingCode ?? null;
    const transportista = lines.find(l => l.carrier)?.carrier ?? null;
    const tipoEnvio = lines.find(l => l.shippingType)?.shippingType ?? null;

    const estados = pedido?.Statuses?.Status;
    const estado = Array.isArray(estados) ? estados.join(', ') : texto(estados);

    return {
        orderNumber: texto(pedido?.OrderNumber) ?? texto(pedido?.OrderId),
        customerName: nombreCliente,
        shipByDate: shipBy,
        lines,
        details: {
            customer: {
                name: nombreCliente,
                email: texto(facturacion?.CustomerEmail) ?? texto(envio?.CustomerEmail),
                phone: texto(envio?.Phone) ?? texto(facturacion?.Phone) ?? texto(envio?.Phone2),
                document: texto(pedido?.NationalRegistrationNumber),
            },
            shipping: {
                method: tipoEnvio,
                status: estado,
                trackingCode: rastreo,
                carrier: transportista,
                shipBy: iso(shipBy),
                deliveryBy: null,
                address: {
                    line: direccion,
                    city: texto(envio?.City) ?? texto(envio?.Ward),
                    region: texto(envio?.Region),
                    country: texto(envio?.Country),
                    postalCode: texto(envio?.PostCode),
                    receiver: unir(envio?.FirstName, envio?.LastName),
                    notes: texto(pedido?.DeliveryInfo),
                },
            },
            payment: {
                method: texto(pedido?.PaymentMethod),
                status: null,
                paidAmount: numero(pedido?.Price),
                installments: null,
                approvedAt: iso(fechaFalabella(pedido?.CreatedAt, desfase)),
            },
            notes: texto(pedido?.Remarks),
            channelStatus: estado,
        },
    };
}

// ─────────────────────────────────────────────────────────────
// Mercado Libre
// ─────────────────────────────────────────────────────────────

export function normalizeMeliOrder(order: any, shipment?: any | null): NormalizedOrder {
    const comprador = order?.buyer ?? {};
    const pago = Array.isArray(order?.payments) ? order.payments[0] : null;
    const destino = shipment?.receiver_address ?? {};
    const opcion = shipment?.shipping_option ?? {};

    const nombreCliente =
        unir(comprador?.first_name, comprador?.last_name) ??
        texto(destino?.receiver_name) ??
        texto(comprador?.nickname);

    const lines: OrderLine[] = (order?.order_items ?? []).map((i: any) => ({
        sku: texto(i?.item?.seller_sku) ?? texto(i?.item?.seller_custom_field),
        title: texto(i?.item?.title) ?? 'Producto',
        quantity: numero(i?.quantity) ?? 1,
        unitPrice: numero(i?.unit_price) ?? 0,
        listPrice: numero(i?.full_unit_price),
        shippingAmount: null,
        status: null,
        trackingCode: texto(shipment?.tracking_number),
        carrier: texto(shipment?.tracking_method),
        shippingType: texto(opcion?.name) ?? texto(shipment?.logistic_type),
        channelItemId: texto(i?.item?.id),
        channelVariationId: texto(i?.item?.variation_id),
    }));

    const limite = texto(opcion?.estimated_handling_limit?.date);
    const shipBy = limite && !Number.isNaN(new Date(limite).getTime()) ? new Date(limite) : null;
    const entrega = texto(opcion?.estimated_delivery_final?.date) ?? texto(opcion?.estimated_delivery_time?.date);

    return {
        orderNumber: texto(order?.id),
        customerName: nombreCliente,
        shipByDate: shipBy,
        lines,
        details: {
            customer: {
                name: nombreCliente,
                email: null, // Mercado Libre oculta el correo del comprador
                phone: texto(destino?.receiver_phone),
                document: null,
                nickname: texto(comprador?.nickname),
            },
            shipping: {
                method: texto(opcion?.name) ?? texto(shipment?.logistic_type),
                status: unir(shipment?.status, shipment?.substatus ? `(${shipment.substatus})` : null),
                trackingCode: texto(shipment?.tracking_number),
                carrier: texto(shipment?.tracking_method),
                shipBy: iso(shipBy),
                deliveryBy: entrega,
                address: {
                    line: texto(destino?.address_line),
                    city: texto(destino?.city?.name),
                    region: texto(destino?.state?.name),
                    country: texto(destino?.country?.name),
                    postalCode: texto(destino?.zip_code),
                    receiver: texto(destino?.receiver_name),
                    notes: texto(destino?.comment),
                },
            },
            payment: {
                method: texto(pago?.payment_method_id) ?? texto(pago?.payment_type),
                status: texto(pago?.status),
                paidAmount: numero(order?.paid_amount) ?? numero(pago?.total_paid_amount),
                installments: numero(pago?.installments),
                approvedAt: texto(pago?.date_approved),
            },
            notes: null,
            channelStatus: texto(order?.status),
        },
    };
}

/**
 * Quita de los detalles los datos de contacto de quien compra. Se usa cuando
 * quien mira la venta solo tiene permiso de lectura: ve QUÉ se vendió y a quién
 * se le puso el nombre, pero no su teléfono, correo, documento ni dirección.
 */
export function ocultarContacto(details: OrderDetails | null): OrderDetails | null {
    if (!details) return null;
    return {
        ...details,
        customer: { ...details.customer, email: null, phone: null, document: null },
        shipping: {
            ...details.shipping,
            address: {
                line: null,
                city: details.shipping.address.city,
                region: details.shipping.address.region,
                country: details.shipping.address.country,
                postalCode: null,
                receiver: null,
                notes: null,
            },
        },
    };
}
