import { ChannelListingRow, ChannelOrder } from '../channels/channel-types';
import { OrderLine } from '../order-details';

/**
 * Traduce lo que entrega WooCommerce (REST API v3) al formato común de Synkro:
 * filas «una por SKU» para el catálogo y ventas normalizadas.
 *
 * Son funciones puras y tolerantes: WooCommerce no manda todos los campos
 * siempre (depende de la versión y de los plugins), así que lo que falta queda
 * en null en vez de romper la sincronización.
 */

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

/** WooCommerce manda las fechas GMT sin zona («2026-10-01T12:00:00»): se interpretan como UTC. */
function fechaGmt(raw: any): Date | null {
    const s = texto(raw);
    if (!s) return null;
    const conZona = /(Z|[+-]\d{2}:?\d{2})$/.test(s);
    const d = new Date(conZona ? s : `${s}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
}

type EstadoFila = ChannelListingRow['status'];

function estadoDeProducto(status: any): EstadoFila {
    switch (String(status ?? '').toLowerCase()) {
        case 'publish': return 'published';
        case 'pending': return 'pending';
        default: return 'paused'; // draft, private, trash y cualquier otro
    }
}

/** Precio de lista y precio con descuento vigente de un producto o variación. */
function preciosDe(origen: any, ahora: Date): { regular: number | null; oferta: number | null } {
    const regular = numero(origen?.regular_price) ?? numero(origen?.price);
    const oferta = numero(origen?.sale_price);
    if (regular === null || oferta === null || oferta >= regular) return { regular, oferta: null };

    // Una promoción programada que aún no empieza o que ya venció no cuenta.
    const desde = fechaGmt(origen?.date_on_sale_from_gmt);
    const hasta = fechaGmt(origen?.date_on_sale_to_gmt);
    if (desde && ahora < desde) return { regular, oferta: null };
    if (hasta && ahora > hasta) return { regular, oferta: null };
    return { regular, oferta };
}

/**
 * Synkro necesita que la tienda tenga activada la «gestión de inventario» del
 * producto: sin ella WooCommerce no lleva una cantidad (solo «en stock» /
 * «agotado») y no hay un número que comparar ni actualizar. En ese caso el
 * stock se lee como 0 en vez de inventar una cantidad.
 */
function stockDe(origen: any): number | null {
    if (origen?.manage_stock !== true) return null;
    const n = numero(origen?.stock_quantity);
    return n === null ? 0 : Math.max(0, Math.trunc(n));
}

function descripcionDeVariacion(variacion: any): string | null {
    const attrs: any[] = Array.isArray(variacion?.attributes) ? variacion.attributes : [];
    return attrs
        .map(a => [texto(a?.name), texto(a?.option)].filter(Boolean).join(': '))
        .filter(Boolean)
        .join(' · ') || null;
}

export function filasDeProductoWoo(
    producto: any,
    variaciones: any[],
    moneda: string | null,
    ahora: Date = new Date(),
): { rows: ChannelListingRow[]; sinSku: number } {
    const externalId = texto(producto?.id);
    if (!externalId) return { rows: [], sinSku: 0 };

    const imagenesProducto: string[] = (Array.isArray(producto?.images) ? producto.images : [])
        .map((i: any) => texto(i?.src))
        .filter((u: string | null): u is string => !!u);
    const estadoPadre = estadoDeProducto(producto?.status);
    const base = {
        externalId,
        title: texto(producto?.name) ?? externalId,
        permalink: texto(producto?.permalink),
        currency: moneda,
    };

    const lista = Array.isArray(variaciones) ? variaciones : [];
    const esVariable = String(producto?.type ?? '').toLowerCase() === 'variable';

    if (!esVariable || !lista.length) {
        const sku = texto(producto?.sku);
        if (!sku) return { rows: [], sinSku: 1 };
        const { regular, oferta } = preciosDe(producto, ahora);
        return {
            sinSku: 0,
            rows: [{
                ...base,
                sku,
                variationId: null,
                variation: null,
                regularPrice: regular,
                salePrice: oferta,
                stock: stockDe(producto) ?? 0,
                status: estadoPadre,
                imageUrl: imagenesProducto[0] ?? null,
                images: imagenesProducto,
            }],
        };
    }

    const rows: ChannelListingRow[] = [];
    let sinSku = 0;
    for (const v of lista) {
        // La variación NO hereda el SKU del padre: heredarlo enlazaría todas a un mismo producto.
        const sku = texto(v?.sku);
        if (!sku) { sinSku++; continue; }

        const propia = texto(v?.image?.src);
        const imagenes = propia ? [propia, ...imagenesProducto.filter(u => u !== propia)] : imagenesProducto;
        const { regular, oferta } = preciosDe(v, ahora);
        // manage_stock 'parent' = la variación usa el inventario del producto padre.
        const stock = (v?.manage_stock === 'parent' ? stockDe(producto) : stockDe(v)) ?? 0;
        const estadoVariacion = String(v?.status ?? '').toLowerCase();
        // Si el producto no está publicado, ninguna variación lo está.
        const estado: EstadoFila =
            estadoVariacion === 'private' || estadoVariacion === 'draft' || estadoVariacion === 'trash'
                ? 'paused'
                : estadoPadre;

        rows.push({
            ...base,
            sku,
            variationId: texto(v?.id),
            variation: descripcionDeVariacion(v),
            regularPrice: regular ?? numero(producto?.regular_price) ?? numero(producto?.price),
            salePrice: oferta,
            stock,
            status: estado,
            imageUrl: imagenes[0] ?? null,
            images: imagenes,
        });
    }
    return { rows, sinSku };
}

export function normalizarPedidoWoo(pedido: any): ChannelOrder {
    const facturacion = pedido?.billing ?? {};
    const envioRaw = pedido?.shipping ?? {};
    // Muchas tiendas no piden dirección de envío aparte: se usa la de facturación.
    const envioVacio = !texto(envioRaw?.address_1) && !texto(envioRaw?.city);
    const envio = envioVacio ? facturacion : envioRaw;

    const estado = String(pedido?.status ?? '').trim().toLowerCase();
    const paid = estado === 'processing' || estado === 'completed';
    const fecha = fechaGmt(pedido?.date_created_gmt) ?? fechaGmt(pedido?.date_created) ?? new Date();

    const metodoEnvio = texto(pedido?.shipping_lines?.[0]?.method_title);
    const nombreCliente =
        unir(facturacion?.first_name, facturacion?.last_name) ??
        unir(envioRaw?.first_name, envioRaw?.last_name);

    const lines: OrderLine[] = (Array.isArray(pedido?.line_items) ? pedido.line_items : []).map((i: any) => {
        const cantidad = numero(i?.quantity) ?? 1;
        // Si la tienda carga los precios con impuesto incluido, lo que pagó el cliente por el producto lleva ese impuesto.
        const impuesto = pedido?.prices_include_tax ? numero(i?.total_tax) ?? 0 : 0;
        const totalLinea = numero(i?.total);
        // Lo pagado por unidad (con descuentos, sin envío); si no hay total de línea, el precio de catálogo.
        const unitario = totalLinea !== null && cantidad > 0 ? (totalLinea + impuesto) / cantidad : numero(i?.price) ?? 0;
        const variacion = numero(i?.variation_id);
        return {
            sku: texto(i?.sku),
            title: texto(i?.name) ?? 'Producto',
            quantity: cantidad,
            unitPrice: unitario,
            listPrice: null,
            shippingType: metodoEnvio,
            channelItemId: texto(i?.product_id),
            channelVariationId: variacion ? String(variacion) : null,
        };
    });

    const pagadoEl = fechaGmt(pedido?.date_paid_gmt) ?? fechaGmt(pedido?.date_paid);
    const nota = texto(pedido?.customer_note);

    return {
        externalId: String(pedido?.id),
        paid,
        channelStatus: estado,
        totalAmount: numero(pedido?.total) ?? 0,
        currency: texto(pedido?.currency),
        orderDate: fecha,
        normalized: {
            orderNumber: texto(pedido?.number) ?? texto(pedido?.id),
            customerName: nombreCliente,
            shipByDate: null,
            lines,
            details: {
                customer: {
                    name: nombreCliente,
                    email: texto(facturacion?.email),
                    phone: texto(facturacion?.phone) ?? texto(envioRaw?.phone),
                    document: null,
                    nickname: null,
                },
                shipping: {
                    method: metodoEnvio,
                    status: estado || null,
                    trackingCode: null,
                    carrier: null,
                    shipBy: null,
                    deliveryBy: null,
                    address: {
                        line: unir(envio?.address_1, envio?.address_2),
                        city: texto(envio?.city),
                        region: texto(envio?.state),
                        country: texto(envio?.country),
                        postalCode: texto(envio?.postcode),
                        receiver: unir(envio?.first_name, envio?.last_name),
                        notes: nota,
                    },
                },
                payment: {
                    method: texto(pedido?.payment_method_title),
                    status: paid ? 'approved' : null,
                    paidAmount: numero(pedido?.total),
                    installments: null,
                    approvedAt: pagadoEl ? pagadoEl.toISOString() : null,
                },
                notes: nota,
                channelStatus: estado || null,
            },
        },
    };
}
