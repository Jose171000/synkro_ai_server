import { filasDeProductoShopify, idNumericoShopify, normalizarPedidoShopify } from './shopify-mapping';

/**
 * Shopify siempre tiene al menos una variante: el producto «simple» es una
 * variante «Default Title». Lo que se protege: una fila por variante con SKU,
 * ids numéricos para el inventario, precios de oferta y pedidos pagados bien
 * distinguidos de los pendientes, cancelados o reembolsados.
 */
const simple = {
    id: 'gid://shopify/Product/456', title: 'Taza de cerámica', status: 'ACTIVE',
    onlineStoreUrl: 'https://mitienda.com/products/taza',
    featuredImage: { url: 'https://cdn/taza.jpg' },
    images: { nodes: [{ url: 'https://cdn/taza.jpg' }, { url: 'https://cdn/taza2.jpg' }] },
    variants: {
        nodes: [{
            id: 'gid://shopify/ProductVariant/789', sku: 'TAZ-01', title: 'Default Title', price: '25.00',
            compareAtPrice: null, inventoryQuantity: 12,
            selectedOptions: [{ name: 'Title', value: 'Default Title' }], image: null,
        }],
    },
};

const conVariantes = {
    id: 'gid://shopify/Product/100', title: 'Polera', status: 'ACTIVE', onlineStoreUrl: null,
    featuredImage: { url: 'https://cdn/polera.jpg' },
    images: { nodes: [{ url: 'https://cdn/polera.jpg' }, { url: 'https://cdn/polera-2.jpg' }] },
    variants: {
        nodes: [
            {
                id: 'gid://shopify/ProductVariant/1', sku: 'POL-M-ROJ', title: 'M / Rojo', price: '40.00', compareAtPrice: '55.00',
                inventoryQuantity: 3, image: { url: 'https://cdn/polera-roja.jpg' },
                selectedOptions: [{ name: 'Talla', value: 'M' }, { name: 'Color', value: 'Rojo' }],
            },
            {
                id: 'gid://shopify/ProductVariant/2', sku: '', title: 'L / Rojo', price: '40.00', compareAtPrice: null,
                inventoryQuantity: 5, image: null,
                selectedOptions: [{ name: 'Talla', value: 'L' }, { name: 'Color', value: 'Rojo' }],
            },
            {
                id: 'gid://shopify/ProductVariant/3', sku: 'POL-S-AZU', title: 'S / Azul', price: '40.00', compareAtPrice: '30.00',
                inventoryQuantity: -2, image: null,
                selectedOptions: [{ name: 'Talla', value: 'S' }, { name: 'Color', value: 'Azul' }],
            },
        ],
    },
};

describe('idNumericoShopify', () => {
    it('toma la parte final del gid', () => {
        expect(idNumericoShopify('gid://shopify/Product/456')).toBe('456');
        expect(idNumericoShopify('gid://shopify/ProductVariant/789')).toBe('789');
    });
    it('tolera vacíos', () => {
        expect(idNumericoShopify(null)).toBeNull();
        expect(idNumericoShopify(undefined)).toBeNull();
        expect(idNumericoShopify('')).toBeNull();
        expect(idNumericoShopify('sin-numero')).toBeNull();
    });
});

describe('filasDeProductoShopify', () => {
    it('producto simple: una fila, sin descripción de variante pero con variationId', () => {
        const { rows, sinSku } = filasDeProductoShopify(simple, 'PEN');
        expect(sinSku).toBe(0);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            sku: 'TAZ-01', externalId: '456', variationId: '789', variation: null, title: 'Taza de cerámica',
            regularPrice: 25, salePrice: null, stock: 12, status: 'published', currency: 'PEN',
            permalink: 'https://mitienda.com/products/taza', imageUrl: 'https://cdn/taza.jpg',
        });
        expect(rows[0].images).toEqual(['https://cdn/taza.jpg', 'https://cdn/taza2.jpg']);
    });

    it('con variantes: una fila por variante con SKU y la que no tiene se cuenta aparte', () => {
        const { rows, sinSku } = filasDeProductoShopify(conVariantes, 'USD');
        expect(sinSku).toBe(1);
        expect(rows.map(r => r.sku)).toEqual(['POL-M-ROJ', 'POL-S-AZU']);
        expect(rows[0]).toMatchObject({ externalId: '100', variationId: '1', variation: 'Talla: M · Color: Rojo' });
        expect(rows[1].variationId).toBe('3');
    });

    it('compareAtPrice mayor que el precio es una oferta; si no, no lo es', () => {
        const { rows } = filasDeProductoShopify(conVariantes, null);
        expect(rows[0]).toMatchObject({ regularPrice: 55, salePrice: 40 });
        expect(rows[1]).toMatchObject({ regularPrice: 40, salePrice: null }); // compareAt 30 < precio 40
    });

    it('el stock nunca es negativo y null cuenta como 0', () => {
        expect(filasDeProductoShopify(conVariantes, null).rows[1].stock).toBe(0);
        const p = { ...simple, variants: { nodes: [{ ...simple.variants.nodes[0], inventoryQuantity: null }] } };
        expect(filasDeProductoShopify(p, null).rows[0].stock).toBe(0);
    });

    it('la imagen de la variante va primero y no se repiten', () => {
        const { rows } = filasDeProductoShopify(conVariantes, null);
        expect(rows[0].imageUrl).toBe('https://cdn/polera-roja.jpg');
        expect(rows[0].images).toEqual(['https://cdn/polera-roja.jpg', 'https://cdn/polera.jpg', 'https://cdn/polera-2.jpg']);
        expect(rows[1].imageUrl).toBe('https://cdn/polera.jpg');
    });

    it('limita las imágenes a 10', () => {
        const muchas = Array.from({ length: 20 }, (_, i) => ({ url: `https://cdn/${i}.jpg` }));
        const p = { ...simple, images: { nodes: muchas } };
        expect(filasDeProductoShopify(p, null).rows[0].images).toHaveLength(10);
    });

    it('traduce el estado del producto', () => {
        const estado = (status: string) => filasDeProductoShopify({ ...simple, status }, null).rows[0].status;
        expect(estado('ACTIVE')).toBe('published');
        expect(estado('DRAFT')).toBe('pending');
        expect(estado('ARCHIVED')).toBe('paused');
        expect(estado('OTRO')).toBe('paused');
    });

    it('una variante sin SKU no hereda nada del producto', () => {
        const p = { ...simple, variants: { nodes: [{ ...simple.variants.nodes[0], sku: null }] } };
        expect(filasDeProductoShopify(p, null)).toEqual({ rows: [], sinSku: 1 });
    });

    it('datos vacíos no rompen', () => {
        expect(filasDeProductoShopify(null, null)).toEqual({ rows: [], sinSku: 0 });
        expect(filasDeProductoShopify({ id: 'gid://shopify/Product/1' }, null)).toEqual({ rows: [], sinSku: 0 });
    });
});

const pedidoBase = {
    id: 'gid://shopify/Order/5001', name: '#1001', createdAt: '2026-10-01T15:30:00Z', cancelledAt: null,
    displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED',
    currentTotalPriceSet: { shopMoney: { amount: '90.50', currencyCode: 'PEN' } },
    email: 'pedido@correo.com', phone: null, note: 'Dejar con el portero',
    customer: { firstName: 'Ana', lastName: 'Ruiz', email: 'ana@correo.com', phone: '+51999111222' },
    shippingAddress: {
        name: 'Ana Ruiz', address1: 'Av. Lima 123', address2: 'Dpto 4', city: 'Lima', province: 'Lima',
        zip: '15001', country: 'Peru', phone: null,
    },
    paymentGatewayNames: ['shopify_payments', 'gift_card'], processedAt: '2026-10-01T15:31:00Z',
    lineItems: {
        nodes: [{
            id: 'gid://shopify/LineItem/1', title: 'Polera', quantity: 2, sku: 'POL-M-ROJ',
            variant: { id: 'gid://shopify/ProductVariant/1' }, product: { id: 'gid://shopify/Product/100' },
            originalUnitPriceSet: { shopMoney: { amount: '50.00' } },
            discountedUnitPriceSet: { shopMoney: { amount: '45.25' } },
        }],
    },
    fulfillments: [{ trackingInfo: [{ number: 'TRK123', company: 'Olva' }] }],
};

describe('normalizarPedidoShopify', () => {
    it('pedido pagado: datos, líneas, cliente, envío y pago', () => {
        const o = normalizarPedidoShopify(pedidoBase);
        expect(o).toMatchObject({
            externalId: '5001', paid: true, channelStatus: 'paid', totalAmount: 90.5, currency: 'PEN',
        });
        expect(o.orderDate.toISOString()).toBe('2026-10-01T15:30:00.000Z');
        expect(o.normalized.orderNumber).toBe('#1001');
        expect(o.normalized.customerName).toBe('Ana Ruiz');
        expect(o.normalized.lines).toEqual([expect.objectContaining({
            sku: 'POL-M-ROJ', title: 'Polera', quantity: 2, unitPrice: 45.25, listPrice: 50,
            channelItemId: '100', channelVariationId: '1', trackingCode: 'TRK123', carrier: 'Olva',
        })]);
        const d = o.normalized.details;
        expect(d.customer).toEqual({ name: 'Ana Ruiz', email: 'ana@correo.com', phone: '+51999111222', document: null, nickname: null });
        expect(d.shipping).toMatchObject({ status: 'fulfilled', trackingCode: 'TRK123', carrier: 'Olva', method: null });
        expect(d.shipping.address).toMatchObject({
            line: 'Av. Lima 123 Dpto 4', city: 'Lima', region: 'Lima', country: 'Peru', postalCode: '15001', receiver: 'Ana Ruiz',
        });
        expect(d.payment).toMatchObject({
            method: 'shopify_payments, gift_card', status: 'paid', paidAmount: 90.5, approvedAt: '2026-10-01T15:31:00Z',
        });
        expect(d.notes).toBe('Dejar con el portero');
        expect(d.channelStatus).toBe('paid');
    });

    it('solo los estados pagados (o parcialmente) mueven stock', () => {
        const paid = (s: string) => normalizarPedidoShopify({ ...pedidoBase, displayFinancialStatus: s }).paid;
        expect(paid('PAID')).toBe(true);
        expect(paid('PARTIALLY_PAID')).toBe(true);
        expect(paid('PARTIALLY_REFUNDED')).toBe(true);
        for (const s of ['PENDING', 'AUTHORIZED', 'REFUNDED', 'VOIDED', 'EXPIRED']) expect(paid(s)).toBe(false);
    });

    it('pendiente: no pagado y estado en minúsculas', () => {
        const o = normalizarPedidoShopify({ ...pedidoBase, displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'UNFULFILLED', fulfillments: [] });
        expect(o.paid).toBe(false);
        expect(o.channelStatus).toBe('pending');
        expect(o.normalized.details.shipping.trackingCode).toBeNull();
        expect(o.normalized.details.shipping.status).toBe('unfulfilled');
    });

    it('cancelado: nunca está pagado aunque figure PAID', () => {
        const o = normalizarPedidoShopify({ ...pedidoBase, cancelledAt: '2026-10-02T10:00:00Z' });
        expect(o.paid).toBe(false);
        expect(o.channelStatus).toBe('cancelled');
    });

    it('reembolsado: no pagado', () => {
        const o = normalizarPedidoShopify({ ...pedidoBase, displayFinancialStatus: 'REFUNDED' });
        expect(o.paid).toBe(false);
        expect(o.channelStatus).toBe('refunded');
    });

    it('sin cliente usa el nombre del envío y sin datos no rompe', () => {
        const o = normalizarPedidoShopify({ ...pedidoBase, customer: null });
        expect(o.normalized.customerName).toBe('Ana Ruiz');
        expect(o.normalized.details.customer.email).toBe('pedido@correo.com');
        const vacio = normalizarPedidoShopify({ id: 'gid://shopify/Order/9', createdAt: '2026-10-01T00:00:00Z' });
        expect(vacio.externalId).toBe('9');
        expect(vacio.normalized.lines).toEqual([]);
        expect(vacio.normalized.customerName).toBeNull();
        expect(vacio.totalAmount).toBe(0);
    });

    it('si no hay precio con descuento, lo pagado es el precio de lista', () => {
        const p = {
            ...pedidoBase,
            lineItems: { nodes: [{ ...pedidoBase.lineItems.nodes[0], discountedUnitPriceSet: null }] },
        };
        expect(normalizarPedidoShopify(p).normalized.lines[0].unitPrice).toBe(50);
    });
});
