import {
    costosDeRipley, estadoDeVentaRipley, filaDeOfertaRipley, HOST_DE_RIPLEY_POR_DEFECTO, normalizarClaveDeRipley, normalizarHostDeRipley,
    normalizarPedidoRipley, ventaCuentaEnRipley,
} from './ripley-mapping';

/** Un pedido con la forma del ejemplo de la documentación de Mercado Ripley (Mirakl, GET /api/orders). */
const pedido = (over: any = {}, linea: any = {}) => ({
    order_id: '22032706-A',
    commercial_id: '22032706',
    order_state: 'WAITING_ACCEPTANCE',
    created_date: '2026-10-15T13:06:41Z',
    last_updated_date: '2026-10-15T13:10:00Z',
    currency_iso_code: 'PEN',
    customer_debited_date: '2026-10-15T13:07:00Z',
    leadtime_to_ship: 2,
    payment_type: 'TARJETA_RIPLEY_INST',
    payment_workflow: 'PAY_ON_ACCEPTANCE',
    price: 500,
    shipping_price: 15,
    total_price: 515,
    total_commission: 75,
    promotions: { applied_promotions: [], total_deduced_amount: 10 },
    shipping_carrier_code: null,
    shipping_company: null,
    shipping_tracking: null,
    shipping_type_code: 'Principal',
    shipping_type_label: 'Despacho a domicilio - [3 - 5 Días Hábiles]',
    customer: {
        customer_id: '139145704',
        firstname: 'Marcelo',
        lastname: 'Caceres',
        billing_address: { phone: '28136589', firstname: 'Marcelo', lastname: 'Caceres' },
        shipping_address: {
            additional_info: 'Portón verde', city: 'SURCO', country: 'PE', firstname: 'Marcelo', lastname: 'Caceres', phone: '999111222',
            phone_secondary: '74696339', state: 'LIMA', street_1: 'Av. Primavera 123', street_2: 'Depto. 602', zip_code: '15023',
        },
    },
    order_lines: [{
        order_line_id: '23582196', order_line_state: 'WAITING_ACCEPTANCE', offer_sku: 'GAF-01', product_title: 'Gafas de sol', quantity: 2,
        price_unit: 250, price: 500, shipping_price: 15, commission_fee: 75, ...linea,
    }],
    ...over,
});

describe('Ripley: la dirección y la clave', () => {
    it('sin dirección usa la de Perú; acepta https://, rutas y mayúsculas', () => {
        expect(normalizarHostDeRipley('')).toBe(HOST_DE_RIPLEY_POR_DEFECTO);
        expect(normalizarHostDeRipley(undefined)).toBe('ripleyperu-prod.mirakl.net');
        expect(normalizarHostDeRipley(' HTTPS://RipleyPeru-Prod.Mirakl.net/login?x=1 ')).toBe('ripleyperu-prod.mirakl.net');
        expect(normalizarHostDeRipley('ripley-prod.mirakl.net:443')).toBe('ripley-prod.mirakl.net');
    });

    it('solo acepta direcciones de *.mirakl.net: la clave no puede viajar a otro sitio', () => {
        for (const mala of [
            'https://malo.example.com', 'mirakl.net.malo.com', 'ripley.mirakl.net.malo.com', 'malo.com/mirakl.net', 'ripley@malo.com',
            'ripleyperu-prod.mirakl.net@malo.com', '127.0.0.1', 'localhost', 'ftp://ripley.mirakl.net', 'ripley mirakl.net', 'ripley\\.mirakl.net', 'xmirakl.net',
        ]) expect(() => normalizarHostDeRipley(mala)).toThrow(/mirakl\.net|válida/);
    });

    it('la clave: sin espacios ni caracteres que rompan una cabecera, y con un largo razonable', () => {
        expect(normalizarClaveDeRipley('  abcd1234abcd1234-xyz  ')).toBe('abcd1234abcd1234-xyz');
        expect(() => normalizarClaveDeRipley('')).toThrow(/Falta la clave/);
        expect(() => normalizarClaveDeRipley('corta')).toThrow(/no parece válida/);
        expect(() => normalizarClaveDeRipley('abcd1234 abcd1234xyz')).toThrow(/no parece válida/);
        expect(() => normalizarClaveDeRipley('abcd1234abcd1234\r\nX-Evil: 1')).toThrow(/no parece válida/);
        expect(() => normalizarClaveDeRipley('a'.repeat(201))).toThrow(/no parece válida/);
    });
});

describe('Ripley: estado de la venta', () => {
    const e = (order_state: string, extra: any = {}) => estadoDeVentaRipley({ order_state, ...extra });

    it('esperando tu aceptación, aceptada y por despachar, o con incidencia: pendiente', () => {
        for (const s of ['STAGING', 'WAITING_ACCEPTANCE', 'WAITING_DEBIT', 'WAITING_DEBIT_PAYMENT', 'SHIPPING', 'INCIDENT_OPEN']) expect(e(s)).toBe('pendiente');
    });
    it('enviada o lista para que el cliente la retire: enviado', () => {
        expect(e('SHIPPED')).toBe('enviado');
        expect(e('TO_COLLECT')).toBe('enviado');
    });
    it('recibida o cerrada: entregado', () => {
        expect(e('RECEIVED')).toBe('entregado');
        expect(e('CLOSED')).toBe('entregado');
    });
    it('cancelada o rechazada: cancelado', () => {
        expect(e('CANCELED')).toBe('cancelado');
        expect(e('REFUSED')).toBe('cancelado');
    });
    it('cerrada por reembolso, o con todas las líneas reembolsadas: devuelto', () => {
        expect(e('CLOSED', { order_state_reason_code: 'REFUNDED' })).toBe('devuelto');
        expect(e('CLOSED', { order_lines: [{ order_line_state: 'REFUNDED' }, { order_line_state: 'REFUNDED' }] })).toBe('devuelto');
        expect(e('CLOSED', { order_lines: [{ order_line_state: 'REFUNDED' }, { order_line_state: 'CLOSED' }] })).toBe('entregado');
    });
    it('mayúsculas, minúsculas y estados desconocidos no rompen nada', () => {
        expect(e('shipped')).toBe('enviado');
        expect(e('ALGO_NUEVO')).toBe('pendiente');
        expect(estadoDeVentaRipley({})).toBe('pendiente');
        expect(estadoDeVentaRipley(null)).toBe('pendiente');
    });
});

describe('Ripley: cuándo cuenta como venta', () => {
    it('cuenta desde que espera tu aceptación (el producto ya está apartado) y hasta que se cierra', () => {
        for (const s of ['WAITING_ACCEPTANCE', 'SHIPPING', 'SHIPPED', 'TO_COLLECT', 'RECEIVED', 'CLOSED', 'INCIDENT_OPEN']) expect(ventaCuentaEnRipley({ order_state: s })).toBe(true);
    });
    it('no cuenta mientras el cliente no termina de pagar, ni si se canceló o rechazó', () => {
        for (const s of ['STAGING', 'WAITING_DEBIT', 'WAITING_DEBIT_PAYMENT', 'CANCELED', 'REFUSED', '']) expect(ventaCuentaEnRipley({ order_state: s })).toBe(false);
    });
});

describe('Ripley: envío y cupones', () => {
    it('envío pagado por el cliente y cupón del canal', () => {
        expect(costosDeRipley(pedido())).toEqual({ shippingPaid: 15, shippingSellerCost: null, shippingType: 'comprador', discountAmount: 10, discountSellerFunded: null });
    });
    it('sin envío cobrado: gratis si hay despacho, retiro si es en tienda, sin dato si no dice nada', () => {
        expect(costosDeRipley(pedido({ shipping_price: 0 })).shippingType).toBe('gratis');
        expect(costosDeRipley(pedido({ shipping_price: 0, shipping_type_label: 'Retiro en tienda', shipping_type_code: 'Retiro' })).shippingType).toBe('retiro');
        expect(costosDeRipley(pedido({ shipping_price: 0, shipping_type_label: null, shipping_type_code: null })).shippingType).toBe('sin_dato');
    });
    it('datos ausentes dan ceros, no errores', () => {
        expect(costosDeRipley({})).toEqual({ shippingPaid: 0, shippingSellerCost: null, shippingType: 'sin_dato', discountAmount: 0, discountSellerFunded: null });
    });
});

describe('Ripley: el pedido en el formato común', () => {
    it('traduce cliente, dirección, líneas, pago y estado', () => {
        const o = normalizarPedidoRipley(pedido());
        expect(o).toMatchObject({
            externalId: '22032706-A', paid: true, channelStatus: 'waiting_acceptance', saleState: 'pendiente', totalAmount: 515, currency: 'PEN',
        });
        expect(o.orderDate.toISOString()).toBe('2026-10-15T13:06:41.000Z');
        expect(o.normalized.orderNumber).toBe('22032706-A');
        expect(o.normalized.customerName).toBe('Marcelo Caceres');
        expect(o.normalized.lines).toEqual([expect.objectContaining({ sku: 'GAF-01', title: 'Gafas de sol', quantity: 2, unitPrice: 250, shippingAmount: 15, status: 'WAITING_ACCEPTANCE', channelItemId: '23582196' })]);
        const d = o.normalized.details;
        expect(d.customer).toMatchObject({ name: 'Marcelo Caceres', phone: '999111222', email: null });
        expect(d.shipping).toMatchObject({ status: 'waiting_acceptance', method: 'Despacho a domicilio - [3 - 5 Días Hábiles]' });
        expect(d.shipping.address).toMatchObject({ line: 'Av. Primavera 123 Depto. 602', city: 'SURCO', region: 'LIMA', country: 'PE', postalCode: '15023', receiver: 'Marcelo Caceres', notes: 'Portón verde' });
        expect(d.payment).toMatchObject({ method: 'TARJETA_RIPLEY_INST', paidAmount: 515, approvedAt: '2026-10-15T13:07:00.000Z' });
        expect(o.costs).toEqual(o.normalized.costs);
    });

    it('la fecha límite de despacho es la que informe Ripley, o la del pedido más el plazo', () => {
        expect(normalizarPedidoRipley(pedido()).normalized.shipByDate?.toISOString()).toBe('2026-10-17T13:06:41.000Z');
        expect(normalizarPedidoRipley(pedido({ shipping_deadline: '2026-10-20T04:59:59Z' })).normalized.shipByDate?.toISOString()).toBe('2026-10-20T04:59:59.000Z');
        expect(normalizarPedidoRipley(pedido({ leadtime_to_ship: 0 })).normalized.shipByDate).toBeNull();
    });

    it('el seguimiento y el transportista aparecen cuando el pedido se despacha', () => {
        const o = normalizarPedidoRipley(pedido({ order_state: 'SHIPPED', shipping_tracking: 'TRK-99', shipping_company: 'Chilexpress' }));
        expect(o.saleState).toBe('enviado');
        expect(o.normalized.details.shipping).toMatchObject({ trackingCode: 'TRK-99', carrier: 'Chilexpress', status: 'shipped' });
        expect(o.normalized.lines[0]).toMatchObject({ trackingCode: 'TRK-99', carrier: 'Chilexpress' });
    });

    it('un pedido cancelado antes de empezar no cuenta como venta, pero conserva su estado', () => {
        const o = normalizarPedidoRipley(pedido({ order_state: 'REFUSED' }));
        expect(o).toMatchObject({ paid: false, saleState: 'cancelado', channelStatus: 'refused' });
    });

    it('la moneda cae a la de la cuenta si el pedido no la trae; sin líneas ni cliente no se rompe', () => {
        expect(normalizarPedidoRipley(pedido({ currency_iso_code: undefined }), 'PEN').currency).toBe('PEN');
        const vacio = normalizarPedidoRipley({ order_id: 'X-1', order_state: 'SHIPPING' });
        expect(vacio).toMatchObject({ externalId: 'X-1', totalAmount: 0, saleState: 'pendiente' });
        expect(vacio.normalized.lines).toEqual([]);
        expect(vacio.normalized.customerName).toBeNull();
    });
});

describe('Ripley: ofertas como publicaciones', () => {
    const oferta = (over: any = {}) => ({ active: true, offer_id: 16105, price: 99.9, product_title: 'Gafas de sol', quantity: 5, shop_sku: 'GAF-01', state_code: '11', currency_iso_code: 'PEN', discount: null, ...over });

    it('una oferta es una fila por SKU de la tienda', () => {
        expect(filaDeOfertaRipley(oferta())).toEqual({
            sku: 'GAF-01', externalId: '16105', variationId: null, title: 'Gafas de sol', variation: null, regularPrice: 99.9, salePrice: null,
            stock: 5, status: 'published', permalink: null, imageUrl: null, images: [], currency: 'PEN',
        });
    });
    it('inactiva = pausada; el stock nunca es negativo ni decimal', () => {
        expect(filaDeOfertaRipley(oferta({ active: false }))?.status).toBe('paused');
        expect(filaDeOfertaRipley(oferta({ quantity: -3 }))?.stock).toBe(0);
        expect(filaDeOfertaRipley(oferta({ quantity: 4.9 }))?.stock).toBe(4);
    });
    it('arma el enlace público de la ficha con el código del producto (base de la familia, en minúscula); sin código o fuera de Perú, no hay enlace', () => {
        expect(filaDeOfertaRipley(oferta({ product_sku: 'PMP20000960762-3' }))?.permalink).toBe('https://simple.ripley.com.pe/producto-pmp20000960762');
        expect(filaDeOfertaRipley(oferta({ product_sku: 'PMP20000960762' }))?.permalink).toBe('https://simple.ripley.com.pe/producto-pmp20000960762');
        expect(filaDeOfertaRipley(oferta())?.permalink).toBeNull();
        expect(filaDeOfertaRipley(oferta({ product_sku: 'PMP20000960762-3', currency_iso_code: 'CLP' }))?.permalink).toBeNull();
        expect(filaDeOfertaRipley(oferta({ product_sku: 'XYZ-1' }))?.permalink).toBeNull();
    });

    it('con rebaja, el precio normal es el de lista (origin_price) y la rebaja va aparte, no el precio ya rebajado', () => {
        const f = filaDeOfertaRipley(oferta({ price: 120, discount: { discount_price: 120, origin_price: 180 } }));
        expect(f?.regularPrice).toBe(180);
        expect(f?.salePrice).toBe(120);
    });

    it('un descuento vigente menor al precio es el precio de oferta; uno mayor se ignora', () => {
        expect(filaDeOfertaRipley(oferta({ discount: { discount_price: 80 } }))?.salePrice).toBe(80);
        expect(filaDeOfertaRipley(oferta({ discount: { discount_price: 120 } }))?.salePrice).toBeNull();
    });
    it('sin SKU de la tienda no se puede enlazar', () => {
        expect(filaDeOfertaRipley(oferta({ shop_sku: '' }))).toBeNull();
        expect(filaDeOfertaRipley(oferta({ shop_sku: undefined }))).toBeNull();
    });
});
