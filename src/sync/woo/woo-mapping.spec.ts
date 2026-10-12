import { filasDeProductoWoo, normalizarPedidoWoo } from './woo-mapping';

/**
 * Lo que se protege: cada SKU es su propia fila, la variación nunca hereda el
 * SKU del padre, una promoción vencida no cuenta como descuento, y solo los
 * pedidos pagados (processing/completed) se marcan como pagados.
 */
const AHORA = new Date('2026-10-12T12:00:00Z');

const simple = {
    id: 101, name: 'Polo básico', type: 'simple', status: 'publish', sku: 'POLO-01',
    permalink: 'https://mitienda.com/polo', price: '45.00', regular_price: '50.00', sale_price: '45.00',
    date_on_sale_from_gmt: null, date_on_sale_to_gmt: null,
    manage_stock: true, stock_quantity: 12, stock_status: 'instock',
    images: [{ id: 1, src: 'https://img/polo1.jpg' }, { id: 2, src: 'https://img/polo2.jpg' }],
};

const variable = {
    id: 200, name: 'Zapatilla', type: 'variable', status: 'publish', sku: 'ZAP-PADRE',
    permalink: 'https://mitienda.com/zapatilla', price: '100', regular_price: '', sale_price: '',
    manage_stock: false, stock_quantity: null, variations: [201, 202, 203],
    images: [{ id: 5, src: 'https://img/zap.jpg' }],
};

const variaciones = [
    {
        id: 201, sku: 'ZAP-38-ROJO', status: 'publish', regular_price: '100', sale_price: '80',
        manage_stock: true, stock_quantity: 4, image: { id: 9, src: 'https://img/zap-rojo.jpg' },
        attributes: [{ name: 'Talla', option: '38' }, { name: 'Color', option: 'Rojo' }],
    },
    {
        id: 202, sku: '', status: 'publish', regular_price: '100', manage_stock: true, stock_quantity: 3,
        attributes: [{ name: 'Talla', option: '39' }],
    },
    {
        id: 203, sku: 'ZAP-40', status: 'private', regular_price: '100', manage_stock: 'parent',
        image: { id: 0, src: '' }, attributes: [{ name: 'Talla', option: '40' }],
    },
];

describe('producto simple', () => {
    it('da una fila con SKU, precios, stock, estado e imágenes', () => {
        const { rows, sinSku } = filasDeProductoWoo(simple, [], 'PEN', AHORA);
        expect(sinSku).toBe(0);
        expect(rows).toEqual([{
            sku: 'POLO-01', externalId: '101', variationId: null, title: 'Polo básico', variation: null,
            regularPrice: 50, salePrice: 45, stock: 12, status: 'published',
            permalink: 'https://mitienda.com/polo', imageUrl: 'https://img/polo1.jpg',
            images: ['https://img/polo1.jpg', 'https://img/polo2.jpg'], currency: 'PEN',
        }]);
    });

    it('sin SKU no da filas y cuenta como sin SKU', () => {
        expect(filasDeProductoWoo({ ...simple, sku: '  ' }, [], null, AHORA)).toEqual({ rows: [], sinSku: 1 });
    });

    it('sin regular_price usa price y sin sale_price no hay oferta', () => {
        const { rows } = filasDeProductoWoo({ ...simple, regular_price: '', sale_price: '', price: '33.5' }, [], null, AHORA);
        expect(rows[0].regularPrice).toBe(33.5);
        expect(rows[0].salePrice).toBeNull();
    });

    it('una oferta mayor o igual al precio normal no es descuento', () => {
        const { rows } = filasDeProductoWoo({ ...simple, sale_price: '50.00' }, [], null, AHORA);
        expect(rows[0].salePrice).toBeNull();
    });

    it('una promoción vencida o futura no cuenta; una vigente sí', () => {
        const vencida = { ...simple, date_on_sale_from_gmt: '2026-01-01T00:00:00', date_on_sale_to_gmt: '2026-02-01T00:00:00' };
        const futura = { ...simple, date_on_sale_from_gmt: '2026-12-01T00:00:00', date_on_sale_to_gmt: null };
        const vigente = { ...simple, date_on_sale_from_gmt: '2026-10-01T00:00:00', date_on_sale_to_gmt: '2026-10-31T23:59:59' };
        expect(filasDeProductoWoo(vencida, [], null, AHORA).rows[0].salePrice).toBeNull();
        expect(filasDeProductoWoo(futura, [], null, AHORA).rows[0].salePrice).toBeNull();
        expect(filasDeProductoWoo(vigente, [], null, AHORA).rows[0].salePrice).toBe(45);
    });

    it('con la gestión de stock apagada el stock es 0', () => {
        const { rows } = filasDeProductoWoo({ ...simple, manage_stock: false, stock_quantity: null, stock_status: 'instock' }, [], null, AHORA);
        expect(rows[0].stock).toBe(0);
    });

    it('el stock nulo es 0 y el negativo (pedidos pendientes) también', () => {
        expect(filasDeProductoWoo({ ...simple, stock_quantity: null }, [], null, AHORA).rows[0].stock).toBe(0);
        expect(filasDeProductoWoo({ ...simple, stock_quantity: -3 }, [], null, AHORA).rows[0].stock).toBe(0);
    });

    it('traduce los estados', () => {
        const estado = (status: string) => filasDeProductoWoo({ ...simple, status }, [], null, AHORA).rows[0].status;
        expect(estado('publish')).toBe('published');
        expect(estado('draft')).toBe('paused');
        expect(estado('private')).toBe('paused');
        expect(estado('trash')).toBe('paused');
        expect(estado('pending')).toBe('pending');
    });
});

describe('producto variable', () => {
    const { rows, sinSku } = filasDeProductoWoo(variable, variaciones, 'PEN', AHORA);

    it('da una fila por variación con SKU propio y no usa el SKU del padre', () => {
        expect(rows.map(r => r.sku)).toEqual(['ZAP-38-ROJO', 'ZAP-40']);
        expect(rows.every(r => r.sku !== 'ZAP-PADRE')).toBe(true);
        expect(rows.every(r => r.externalId === '200')).toBe(true);
        expect(rows.map(r => r.variationId)).toEqual(['201', '203']);
    });

    it('la variación sin SKU se cuenta aparte', () => {
        expect(sinSku).toBe(1);
    });

    it('describe la variación, usa su imagen primero y su stock y precios', () => {
        expect(rows[0].variation).toBe('Talla: 38 · Color: Rojo');
        expect(rows[0].imageUrl).toBe('https://img/zap-rojo.jpg');
        expect(rows[0].images).toEqual(['https://img/zap-rojo.jpg', 'https://img/zap.jpg']);
        expect(rows[0].stock).toBe(4);
        expect(rows[0].regularPrice).toBe(100);
        expect(rows[0].salePrice).toBe(80);
        expect(rows[0].title).toBe('Zapatilla');
    });

    it('sin imagen propia usa la del producto, y una variación privada queda pausada', () => {
        expect(rows[1].imageUrl).toBe('https://img/zap.jpg');
        expect(rows[1].status).toBe('paused');
        expect(rows[0].status).toBe('published');
    });

    it('si el producto no está publicado ninguna variación lo está', () => {
        const r = filasDeProductoWoo({ ...variable, status: 'draft' }, variaciones, null, AHORA).rows;
        expect(r.every(x => x.status === 'paused')).toBe(true);
    });

    it('una variación con manage_stock «parent» sigue el stock del padre', () => {
        const padre = { ...variable, manage_stock: true, stock_quantity: 9 };
        expect(filasDeProductoWoo(padre, variaciones, null, AHORA).rows[1].stock).toBe(9);
    });

    it('un producto variable sin variaciones leídas se trata como simple', () => {
        const { rows: r } = filasDeProductoWoo(variable, [], null, AHORA);
        expect(r).toHaveLength(1);
        expect(r[0].sku).toBe('ZAP-PADRE');
    });
});

const pedido = {
    id: 7001, number: '7001', status: 'processing', currency: 'PEN', total: '170.00',
    date_created: '2026-10-10T09:00:00', date_created_gmt: '2026-10-10T14:00:00',
    date_paid: '2026-10-10T09:05:00', date_paid_gmt: '2026-10-10T14:05:00',
    payment_method_title: 'Tarjeta de crédito', customer_note: 'Dejar con el portero',
    billing: { first_name: 'Ana', last_name: 'Pérez', email: 'ana@mail.com', phone: '999111222', address_1: 'Av. Sol 1', city: 'Lima', state: 'LIM', country: 'PE', postcode: '15001' },
    shipping: { first_name: 'Luis', last_name: 'Pérez', address_1: 'Calle Luna 5', address_2: 'Dpto 3', city: 'Cusco', state: 'CUS', country: 'PE', postcode: '08000' },
    shipping_lines: [{ method_title: 'Envío estándar' }],
    line_items: [
        { id: 1, name: 'Polo básico', product_id: 101, variation_id: 0, quantity: 2, sku: 'POLO-01', price: 50, total: '90.00' },
        { id: 2, name: 'Zapatilla - 38, Rojo', product_id: 200, variation_id: 201, quantity: 1, sku: 'ZAP-38-ROJO', price: 80, total: '80.00' },
    ],
};

describe('normalizarPedidoWoo', () => {
    const o = normalizarPedidoWoo(pedido);

    it('marca pagado y arma los datos generales', () => {
        expect(o.externalId).toBe('7001');
        expect(o.paid).toBe(true);
        expect(o.channelStatus).toBe('processing');
        expect(o.totalAmount).toBe(170);
        expect(o.currency).toBe('PEN');
        expect(o.orderDate.toISOString()).toBe('2026-10-10T14:00:00.000Z');
    });

    it('las líneas llevan lo pagado por unidad y los ids del canal', () => {
        expect(o.normalized.lines).toEqual([
            { sku: 'POLO-01', title: 'Polo básico', quantity: 2, unitPrice: 45, listPrice: null, channelItemId: '101', channelVariationId: null, shippingType: 'Envío estándar' },
            { sku: 'ZAP-38-ROJO', title: 'Zapatilla - 38, Rojo', quantity: 1, unitPrice: 80, listPrice: null, channelItemId: '200', channelVariationId: '201', shippingType: 'Envío estándar' },
        ]);
    });

    it('cliente, envío y pago', () => {
        const d = o.normalized.details;
        expect(o.normalized.orderNumber).toBe('7001');
        expect(o.normalized.customerName).toBe('Ana Pérez');
        expect(o.normalized.shipByDate).toBeNull();
        expect(d.customer).toEqual({ name: 'Ana Pérez', email: 'ana@mail.com', phone: '999111222', document: null, nickname: null });
        expect(d.shipping.method).toBe('Envío estándar');
        expect(d.shipping.address).toEqual({
            line: 'Calle Luna 5 Dpto 3', city: 'Cusco', region: 'CUS', country: 'PE', postalCode: '08000',
            receiver: 'Luis Pérez', notes: 'Dejar con el portero',
        });
        expect(d.payment).toEqual({
            method: 'Tarjeta de crédito', status: 'approved', paidAmount: 170, installments: null,
            approvedAt: '2026-10-10T14:05:00.000Z',
        });
        expect(d.notes).toBe('Dejar con el portero');
        expect(d.channelStatus).toBe('processing');
    });

    it('completed también es pagado', () => {
        expect(normalizarPedidoWoo({ ...pedido, status: 'completed' }).paid).toBe(true);
    });

    it('un pedido cancelado, pendiente, en espera o reembolsado no está pagado', () => {
        for (const status of ['cancelled', 'pending', 'on-hold', 'refunded', 'failed']) {
            const r = normalizarPedidoWoo({ ...pedido, status: status.toUpperCase() });
            expect(r.paid).toBe(false);
            expect(r.channelStatus).toBe(status);
            expect(r.normalized.details.payment.status).toBeNull();
        }
    });

    it('sin dirección de envío usa la de facturación', () => {
        const r = normalizarPedidoWoo({ ...pedido, shipping: { first_name: '', last_name: '', address_1: '', city: '' } });
        expect(r.normalized.details.shipping.address.line).toBe('Av. Sol 1');
        expect(r.normalized.details.shipping.address.city).toBe('Lima');
        expect(r.normalized.details.shipping.address.receiver).toBe('Ana Pérez');
    });

    it('tolera un pedido casi vacío', () => {
        const r = normalizarPedidoWoo({ id: 5, status: 'processing', total: '10', date_created: '2026-10-10T09:00:00' });
        expect(r.normalized.orderNumber).toBe('5');
        expect(r.normalized.customerName).toBeNull();
        expect(r.normalized.lines).toEqual([]);
        expect(r.normalized.details.payment.approvedAt).toBeNull();
        expect(r.currency).toBeNull();
    });
});

describe('precio pagado por los productos (base de la comisión)', () => {
    const pedido = (over: any) => ({
        id: 9, number: '9', status: 'processing', currency: 'PEN', total: '133.00', date_created_gmt: '2026-10-09T12:00:00',
        shipping_total: '15.00',
        line_items: [{ id: 1, product_id: 5, variation_id: 0, sku: 'A', name: 'A', quantity: 2, total: '84.75', total_tax: '15.25', price: 50 }],
        ...over,
    });

    it('con precios con impuesto incluido, lo pagado por el producto lleva el impuesto y no el envío', () => {
        const o = normalizarPedidoWoo(pedido({ prices_include_tax: true }));
        // (84.75 + 15.25) / 2 = 50 por unidad → 100 en productos; el envío (15) queda fuera.
        expect(o.normalized.lines[0].unitPrice).toBe(50);
        expect(o.normalized.lines[0].quantity * o.normalized.lines[0].unitPrice).toBe(100);
    });

    it('con precios sin impuesto, el impuesto no cuenta como precio del producto', () => {
        const o = normalizarPedidoWoo(pedido({ prices_include_tax: false }));
        expect(o.normalized.lines[0].unitPrice).toBeCloseTo(42.375, 3);
    });
});
