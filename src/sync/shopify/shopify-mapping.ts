import { ChannelListingRow, ChannelOrder } from '../channels/channel-types';
import { OrderLine } from '../order-details';

/**
 * Traduce lo que entrega la Admin GraphQL API de Shopify al formato común de
 * los canales. Son funciones puras y tolerantes: lo que falta queda en null.
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

const unir = (sep: string, ...partes: any[]): string | null => {
    const s = partes.map(texto).filter(Boolean).join(sep).trim();
    return s || null;
};

/** «gid://shopify/Product/456» → «456». */
export function idNumericoShopify(gid: string | null | undefined): string | null {
    const s = texto(gid);
    if (!s) return null;
    const m = s.match(/(\d+)(?:\?.*)?$/);
    return m ? m[1] : null;
}

function estadoDeProducto(status: any): ChannelListingRow['status'] {
    switch (String(status ?? '').toUpperCase()) {
        case 'ACTIVE': return 'published';
        case 'DRAFT': return 'pending';
        default: return 'paused'; // ARCHIVED y lo desconocido
    }
}

export function filasDeProductoShopify(
    producto: any,
    moneda: string | null,
): { rows: ChannelListingRow[]; sinSku: number } {
    const externalId = idNumericoShopify(producto?.id);
    if (!externalId) return { rows: [], sinSku: 0 };

    const variantes: any[] = Array.isArray(producto?.variants?.nodes) ? producto.variants.nodes : [];
    const unicaPorDefecto = variantes.length === 1 && texto(variantes[0]?.title) === 'Default Title';

    const imagenesProducto: string[] = (Array.isArray(producto?.images?.nodes) ? producto.images.nodes : [])
        .map((i: any) => texto(i?.url))
        .filter((u: string | null): u is string => !!u);
    const destacada = texto(producto?.featuredImage?.url);

    const base = {
        externalId,
        title: texto(producto?.title) ?? externalId,
        status: estadoDeProducto(producto?.status),
        permalink: texto(producto?.onlineStoreUrl),
        currency: texto(moneda),
    };

    const rows: ChannelListingRow[] = [];
    let sinSku = 0;
    for (const v of variantes) {
        const sku = texto(v?.sku);
        if (!sku) { sinSku++; continue; }

        const precio = numero(v?.price);
        const comparar = numero(v?.compareAtPrice);
        const enOferta = comparar !== null && precio !== null && comparar > precio;

        const opciones = (Array.isArray(v?.selectedOptions) ? v.selectedOptions : [])
            .filter((o: any) => !(texto(o?.name) === 'Title' && texto(o?.value) === 'Default Title'))
            .map((o: any) => [texto(o?.name), texto(o?.value)].filter(Boolean).join(': '))
            .filter(Boolean)
            .join(' · ') || null;

        const propia = texto(v?.image?.url);
        const imagenes: string[] = [];
        for (const u of [propia, ...imagenesProducto]) {
            if (u && !imagenes.includes(u) && imagenes.length < 10) imagenes.push(u);
        }

        rows.push({
            ...base,
            sku,
            variationId: idNumericoShopify(v?.id),
            variation: unicaPorDefecto ? null : opciones,
            regularPrice: enOferta ? comparar : precio,
            salePrice: enOferta ? precio : null,
            stock: Math.max(0, numero(v?.inventoryQuantity) ?? 0),
            imageUrl: propia ?? destacada ?? imagenesProducto[0] ?? null,
            images: imagenes,
        });
    }
    return { rows, sinSku };
}

const PAGADOS = ['PAID', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED'];

export function normalizarPedidoShopify(pedido: any): ChannelOrder {
    const financiero = texto(pedido?.displayFinancialStatus)?.toUpperCase() ?? null;
    const cancelado = !!texto(pedido?.cancelledAt);
    const paid = !cancelado && !!financiero && PAGADOS.includes(financiero);

    const estadoFinanciero = financiero ? financiero.toLowerCase() : null;
    const channelStatus = cancelado ? 'cancelled' : (estadoFinanciero ?? 'unknown');

    const dinero = pedido?.currentTotalPriceSet?.shopMoney;
    const total = numero(dinero?.amount) ?? 0;
    const fecha = new Date(pedido?.createdAt);

    const cliente = pedido?.customer ?? {};
    const envio = pedido?.shippingAddress ?? {};
    const nombreCliente = unir(' ', cliente?.firstName, cliente?.lastName) ?? texto(envio?.name);

    const envios: any[] = Array.isArray(pedido?.fulfillments) ? pedido.fulfillments : [];
    const seguimientos = envios.flatMap(f => (Array.isArray(f?.trackingInfo) ? f.trackingInfo : []));
    const rastreo = texto(seguimientos.find(t => texto(t?.number))?.number);
    const transportista = texto(seguimientos.find(t => texto(t?.company))?.company);

    const lines: OrderLine[] = (Array.isArray(pedido?.lineItems?.nodes) ? pedido.lineItems.nodes : []).map((l: any) => {
        const original = numero(l?.originalUnitPriceSet?.shopMoney?.amount);
        const pagado = numero(l?.discountedUnitPriceSet?.shopMoney?.amount) ?? original ?? 0;
        return {
            sku: texto(l?.sku),
            title: texto(l?.title) ?? 'Producto',
            quantity: numero(l?.quantity) ?? 1,
            unitPrice: pagado,
            listPrice: original,
            trackingCode: rastreo,
            carrier: transportista,
            channelItemId: idNumericoShopify(l?.product?.id),
            channelVariationId: idNumericoShopify(l?.variant?.id),
        };
    });

    const pasarela = Array.isArray(pedido?.paymentGatewayNames)
        ? pedido.paymentGatewayNames.map(texto).filter(Boolean).join(', ')
        : '';

    return {
        externalId: idNumericoShopify(pedido?.id) ?? String(pedido?.id ?? ''),
        paid,
        channelStatus,
        totalAmount: total,
        currency: texto(dinero?.currencyCode),
        orderDate: fecha,
        normalized: {
            orderNumber: texto(pedido?.name) ?? idNumericoShopify(pedido?.id),
            customerName: nombreCliente,
            shipByDate: null,
            lines,
            details: {
                customer: {
                    name: nombreCliente,
                    email: texto(cliente?.email) ?? texto(pedido?.email),
                    phone: texto(cliente?.phone) ?? texto(pedido?.phone) ?? texto(envio?.phone),
                    document: null,
                    nickname: null,
                },
                shipping: {
                    method: null,
                    status: texto(pedido?.displayFulfillmentStatus)?.toLowerCase() ?? null,
                    trackingCode: rastreo,
                    carrier: transportista,
                    shipBy: null,
                    deliveryBy: null,
                    address: {
                        line: unir(' ', envio?.address1, envio?.address2),
                        city: texto(envio?.city),
                        region: texto(envio?.province),
                        country: texto(envio?.country),
                        postalCode: texto(envio?.zip),
                        receiver: texto(envio?.name),
                        notes: null,
                    },
                },
                payment: {
                    method: pasarela || null,
                    status: estadoFinanciero,
                    paidAmount: total,
                    installments: null,
                    approvedAt: texto(pedido?.processedAt),
                },
                notes: texto(pedido?.note),
                channelStatus,
            },
        },
    };
}
