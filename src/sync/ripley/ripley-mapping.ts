import { BadRequestException } from '@nestjs/common';
import { EstadoDeVenta } from '../estado-de-venta';
import { familiaDeProducto } from './variantes-ripley';
import { CostosDeVenta } from '../costos-de-venta';
import { NormalizedOrder, OrderLine } from '../order-details';
import { ChannelListingRow, ChannelOrder } from '../channels/channel-types';

/**
 * Mercado Ripley corre sobre Mirakl: una API key por tienda y una dirección propia de cada país
 * (Perú: ripleyperu-prod.mirakl.net; Chile: ripley-prod.mirakl.net). Ver docs/ripley-integracion.md.
 * Todo lo de este archivo es lógica pura (sin red), para poder probarla.
 */

/** La instancia de Mercado Ripley Perú. Se puede cambiar al conectar (otro país u otro ambiente). */
export const HOST_DE_RIPLEY_POR_DEFECTO = 'ripleyperu-prod.mirakl.net';

const HOST_VALIDO = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.mirakl\.net$/i;

/**
 * La dirección con la que se habla a Ripley, normalizada (sin https://, sin ruta). Solo se aceptan direcciones de
 * `*.mirakl.net`: la clave de la tienda viaja en cada llamada y no debe poder mandarse a otro sitio.
 */
export function normalizarHostDeRipley(entrada: unknown): string {
    const bruto = String(entrada ?? '').trim();
    if (!bruto) return HOST_DE_RIPLEY_POR_DEFECTO;
    const sinEsquema = bruto.replace(/^https?:\/\//i, '');
    if (/^[a-z]+:\/\//i.test(sinEsquema) || /[\s@\\]/.test(sinEsquema)) {
        throw new BadRequestException('La dirección de Ripley no es válida. Debe ser como ripleyperu-prod.mirakl.net.');
    }
    const host = sinEsquema.split(/[/?#]/)[0].replace(/:443$/, '').toLowerCase();
    if (!HOST_VALIDO.test(host)) {
        throw new BadRequestException('La dirección de Ripley no es válida. Debe terminar en .mirakl.net (por ejemplo ripleyperu-prod.mirakl.net).');
    }
    return host;
}

/** La clave de la tienda, sin espacios y sin nada que pueda romper una cabecera HTTP. */
export function normalizarClaveDeRipley(entrada: unknown): string {
    const clave = String(entrada ?? '').trim();
    if (!clave) throw new BadRequestException('Falta la clave de API de Ripley (la sacas en el portal de vendedor, pulsando tu correo arriba a la derecha).');
    if (/[\s\r\n"'<>]/.test(clave) || clave.length < 16 || clave.length > 200) {
        throw new BadRequestException('La clave de API de Ripley no parece válida. Cópiala completa desde el portal, sin espacios.');
    }
    return clave;
}

// ── Estados ───────────────────────────────────────────────────────────────

const texto = (v: unknown): string | null => {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s ? s : null;
};
const numero = (v: unknown): number | null => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const mayus = (v: unknown) => String(v ?? '').trim().toUpperCase();

/**
 * El estado común de una venta de Ripley (Mirakl):
 *  - cancelada o rechazada → cancelado; reembolsada → devuelto;
 *  - enviada o lista para retirar → enviado; recibida o cerrada → entregado;
 *  - el resto (esperando que la aceptes, aceptada y por despachar, con incidencia) → pendiente.
 */
export function estadoDeVentaRipley(orden: any): EstadoDeVenta {
    const estado = mayus(orden?.order_state);
    const lineas: any[] = Array.isArray(orden?.order_lines) ? orden.order_lines : [];
    const todasReembolsadas = lineas.length > 0 && lineas.every((l) => mayus(l?.order_line_state) === 'REFUNDED');

    if (estado === 'CANCELED' || estado === 'CANCELLED' || estado === 'REFUSED') return 'cancelado';
    if (mayus(orden?.order_state_reason_code) === 'REFUNDED' || todasReembolsadas) return 'devuelto';
    if (estado === 'RECEIVED' || estado === 'CLOSED') return 'entregado';
    if (estado === 'SHIPPED' || estado === 'TO_COLLECT') return 'enviado';
    return 'pendiente';
}

/**
 * ¿Es una venta que ya cuenta (y mueve el stock)? Mientras el cliente no ha terminado el pago (STAGING, esperando el cobro),
 * o si se canceló o rechazó antes de empezar, todavía no. Una venta que espera tu aceptación sí cuenta: el producto ya está
 * apartado para ese cliente.
 */
export function ventaCuentaEnRipley(orden: any): boolean {
    const estado = mayus(orden?.order_state);
    if (['STAGING', 'WAITING_DEBIT', 'WAITING_DEBIT_PAYMENT', 'CANCELED', 'CANCELLED', 'REFUSED'].includes(estado)) return false;
    return !!estado;
}

// ── Envío y cupones ───────────────────────────────────────────────────────

export function costosDeRipley(orden: any): CostosDeVenta {
    const pagado = numero(orden?.shipping_price) ?? 0;
    const etiqueta = `${orden?.shipping_type_label ?? ''} ${orden?.shipping_type_code ?? ''}`.toLowerCase();
    let tipo: CostosDeVenta['shippingType'] = 'sin_dato';
    if (pagado > 0) tipo = 'comprador';
    else if (/retiro|tienda|collect|pickup|pick-up/.test(etiqueta)) tipo = 'retiro';
    else if (etiqueta.trim()) tipo = 'gratis';
    return {
        shippingPaid: r2(pagado),
        // Ripley no dice lo que le costó el despacho al vendedor.
        shippingSellerCost: null,
        shippingType: tipo,
        discountAmount: r2(numero(orden?.promotions?.total_deduced_amount) ?? 0),
        discountSellerFunded: null,
    };
}

// ── Pedido ────────────────────────────────────────────────────────────────

const fecha = (v: unknown): Date | null => {
    const s = texto(v);
    if (!s) return null;
    // Mirakl manda UTC («…Z»); si faltara la zona, se toma como UTC.
    const d = new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
};
const unir = (...partes: unknown[]): string | null => partes.map(texto).filter(Boolean).join(' ').trim() || null;

/** Traduce un pedido de Ripley (GET /api/orders) al formato común. */
export function normalizarPedidoRipley(orden: any, monedaDeLaCuenta?: string | null): ChannelOrder {
    const cliente = orden?.customer ?? {};
    const envio = cliente?.shipping_address ?? {};
    const facturacion = cliente?.billing_address ?? {};
    const nombre = unir(cliente?.firstname, cliente?.lastname) ?? unir(envio?.firstname, envio?.lastname);
    const estadoDelCanal = (mayus(orden?.order_state) || 'DESCONOCIDO').toLowerCase();
    const moneda = texto(orden?.currency_iso_code) ?? monedaDeLaCuenta ?? null;

    const transportista = texto(orden?.shipping_company) ?? texto(orden?.shipping_carrier_code);
    const rastreo = texto(orden?.shipping_tracking);
    const metodo = texto(orden?.shipping_type_label) ?? texto(orden?.shipping_type_code);

    const lineas: OrderLine[] = (Array.isArray(orden?.order_lines) ? orden.order_lines : []).map((l: any): OrderLine => ({
        sku: texto(l?.offer_sku),
        title: texto(l?.product_title) ?? 'Producto',
        quantity: numero(l?.quantity) ?? 1,
        unitPrice: numero(l?.price_unit) ?? 0,
        listPrice: null,
        shippingAmount: numero(l?.shipping_price),
        status: texto(l?.order_line_state),
        trackingCode: rastreo,
        carrier: transportista,
        shippingType: texto(orden?.shipping_type_code),
        channelItemId: texto(l?.order_line_id),
        variant: null,
    }));

    // Fecha límite para despachar: la que informe Ripley; si no, la del pedido más los días de plazo.
    const creada = fecha(orden?.created_date) ?? new Date();
    const plazoDias = numero(orden?.leadtime_to_ship);
    const limite = fecha(orden?.shipping_deadline) ?? (plazoDias && plazoDias > 0 ? new Date(creada.getTime() + plazoDias * 86_400_000) : null);

    const direccion = unir(envio?.street_1, envio?.street_2);
    const normalized: NormalizedOrder = {
        costs: costosDeRipley(orden),
        orderNumber: texto(orden?.order_id) ?? texto(orden?.commercial_id),
        customerName: nombre,
        shipByDate: limite,
        lines: lineas,
        details: {
            customer: {
                name: nombre,
                // Mirakl no entrega el correo del cliente; el teléfono viene en la dirección.
                email: null,
                phone: texto(envio?.phone) ?? texto(facturacion?.phone) ?? texto(envio?.phone_secondary),
                document: null,
            },
            shipping: {
                method: metodo,
                status: estadoDelCanal,
                trackingCode: rastreo,
                carrier: transportista,
                shipBy: limite ? limite.toISOString() : null,
                deliveryBy: null,
                address: {
                    line: direccion,
                    city: texto(envio?.city),
                    region: texto(envio?.state),
                    country: texto(envio?.country) ?? texto(envio?.country_iso_code),
                    postalCode: texto(envio?.zip_code),
                    receiver: unir(envio?.firstname, envio?.lastname),
                    notes: texto(envio?.additional_info),
                },
            },
            payment: {
                method: texto(orden?.payment_type) ?? texto(orden?.paymentType),
                status: texto(orden?.payment_workflow),
                paidAmount: numero(orden?.total_price),
                installments: null,
                approvedAt: fecha(orden?.customer_debited_date)?.toISOString() ?? null,
            },
            notes: null,
            channelStatus: estadoDelCanal,
        },
    };

    return {
        externalId: String(orden?.order_id ?? ''),
        paid: ventaCuentaEnRipley(orden),
        channelStatus: estadoDelCanal,
        saleState: estadoDeVentaRipley(orden),
        costs: normalized.costs,
        totalAmount: numero(orden?.total_price) ?? numero(orden?.price) ?? 0,
        currency: moneda,
        orderDate: creada,
        normalized,
    };
}

// ── Ofertas (publicaciones) ───────────────────────────────────────────────

/** Solo se aceptan fotos servidas por Mirakl por https (la IA y el navegador las abren: no deben apuntar a cualquier sitio). */
export function esFotoDeMirakl(url: unknown): url is string {
    if (typeof url !== 'string') return false;
    try {
        const u = new URL(url);
        return u.protocol === 'https:' && (u.hostname === 'mirakl.net' || u.hostname.endsWith('.mirakl.net'));
    } catch { return false; }
}

/**
 * Las fotos de la respuesta de P11 (GET /api/products/offers): código de producto → primera foto válida.
 * Se busca de forma tolerante porque Mirakl las puede dar como lista o como objeto (product_media) según la versión.
 */
export function fotosDeRespuestaP11(respuesta: any): Map<string, string> {
    const fotos = new Map<string, string>();
    const productos: any[] = Array.isArray(respuesta?.products) ? respuesta.products : [];
    for (const p of productos) {
        const codigo = texto(p?.product_sku) ?? texto(p?.product_id) ?? texto(p?.sku);
        if (!codigo) continue;
        const media = p?.product_media ?? p?.media ?? [];
        const lista: any[] = Array.isArray(media) ? media : [media];
        const url = lista.map((m) => (typeof m === 'string' ? m : m?.media_url ?? m?.url)).find(esFotoDeMirakl);
        if (url) fotos.set(codigo, url);
    }
    return fotos;
}

/** Una oferta de Ripley (GET /api/offers) como fila por SKU. Sin SKU de la tienda no se puede enlazar: devuelve null. */
export function filaDeOfertaRipley(oferta: any, monedaDeLaCuenta?: string | null): ChannelListingRow | null {
    const sku = texto(oferta?.shop_sku);
    if (!sku) return null;
    const precio = numero(oferta?.price);
    const conDescuento = numero(oferta?.discount?.discount_price) ?? numero(oferta?.discount?.price);
    const stock = Math.max(0, Math.trunc(numero(oferta?.quantity) ?? 0));
    return {
        sku,
        externalId: String(oferta?.offer_id ?? sku),
        variationId: null,
        title: texto(oferta?.product_title) ?? sku,
        variation: null,
        regularPrice: precio,
        salePrice: conDescuento != null && precio != null && conDescuento < precio ? conDescuento : null,
        stock,
        status: oferta?.active === false ? 'paused' : 'published',
        permalink: null,
        imageUrl: null,
        images: [],
        currency: texto(oferta?.currency_iso_code) ?? monedaDeLaCuenta ?? null,
        // «PMP20001695273-5»: la base es la familia de variantes.
        ...(familiaDeProducto(oferta?.product_sku) ? { groupKey: familiaDeProducto(oferta?.product_sku)!.base } : {}),
        ...(texto(oferta?.product_sku) ? { productSku: texto(oferta?.product_sku) } : {}),
    };
}
