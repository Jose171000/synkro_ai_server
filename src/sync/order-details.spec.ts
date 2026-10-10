import { fechaFalabella, normalizeFalabellaOrder, normalizeMeliOrder, ocultarContacto } from './order-details';

/**
 * Cada canal cuenta una venta a su manera. Lo que se protege: que de cualquiera
 * salgan el cliente, la fecha límite de envío, lo que se pagó por cada línea y
 * el destino; que las fechas sin zona horaria no se corran de día; y que un
 * canal que omite campos no rompa nada.
 */
const pedido = {
    OrderId: 123456, OrderNumber: '7001234', CustomerFirstName: 'Lucía', CustomerLastName: 'Paredes',
    Price: '149.90', PaymentMethod: 'CreditCard', CreatedAt: '2026-10-09 10:15:00',
    PromisedShippingTime: '2026-10-12 23:59:59', Remarks: 'Llamar antes', DeliveryInfo: 'Portón verde',
    NationalRegistrationNumber: '45678912',
    AddressShipping: {
        FirstName: 'Lucía', LastName: 'Paredes', Phone: '999111222', Address1: 'Av. Primavera 123', Address2: 'Dpto 402',
        City: 'Surco', Region: 'Lima', PostCode: '15023', Country: 'Perú',
    },
    AddressBilling: { CustomerEmail: 'lucia@correo.com' },
    Statuses: { Status: 'pending' },
};
const lineas = [
    { OrderItemId: '1', Sku: 'GAF-01', Name: 'Gafas de sol', ItemPrice: '199.90', PaidPrice: '149.90', ShippingAmount: '9.90', Status: 'pending', ShipmentProvider: 'Olva', TrackingCode: 'TRK1', ShippingType: 'Dropshipping' },
];

describe('fechas de Falabella (sin zona horaria)', () => {
    it('una fecha sin zona se toma en hora de Lima: no se corre de día', () => {
        const d = fechaFalabella('2026-10-12 23:59:59')!;
        expect(d.toISOString()).toBe('2026-10-13T04:59:59.000Z'); // 23:59 en Lima = 04:59 UTC del día siguiente
    });

    it('si la fecha ya trae zona, se respeta', () => {
        expect(fechaFalabella('2026-10-12T10:00:00Z')!.toISOString()).toBe('2026-10-12T10:00:00.000Z');
        expect(fechaFalabella('2026-10-12T10:00:00-03:00')!.toISOString()).toBe('2026-10-12T13:00:00.000Z');
    });

    it('un valor vacío o inválido da null en vez de romper', () => {
        expect(fechaFalabella(undefined)).toBeNull();
        expect(fechaFalabella('')).toBeNull();
        expect(fechaFalabella('no es una fecha')).toBeNull();
    });

    it('una cuenta en pesos chilenos usa la hora de Chile', () => {
        const r = normalizeFalabellaOrder({ ...pedido, PromisedShippingTime: '2026-10-12 12:00:00' }, lineas, 'CLP');
        expect(r.shipByDate!.toISOString()).toBe('2026-10-12T15:00:00.000Z');
    });
});

describe('venta de Falabella', () => {
    const r = normalizeFalabellaOrder(pedido, lineas, 'PEN');

    it('trae número de pedido, cliente y fecha máxima de envío', () => {
        expect(r.orderNumber).toBe('7001234');
        expect(r.customerName).toBe('Lucía Paredes');
        expect(r.shipByDate!.toISOString()).toBe('2026-10-13T04:59:59.000Z');
    });

    it('cada línea trae el precio pagado, el de lista y el envío', () => {
        expect(r.lines[0]).toMatchObject({
            sku: 'GAF-01', title: 'Gafas de sol', quantity: 1, unitPrice: 149.9, listPrice: 199.9, shippingAmount: 9.9,
            carrier: 'Olva', trackingCode: 'TRK1',
        });
    });

    it('guarda el destino, el pago y las notas', () => {
        expect(r.details.shipping.address).toMatchObject({ line: 'Av. Primavera 123 Dpto 402', city: 'Surco', region: 'Lima', country: 'Perú', postalCode: '15023' });
        expect(r.details.shipping.trackingCode).toBe('TRK1');
        expect(r.details.customer).toMatchObject({ phone: '999111222', email: 'lucia@correo.com', document: '45678912' });
        expect(r.details.payment).toMatchObject({ method: 'CreditCard', paidAmount: 149.9 });
        expect(r.details.notes).toBe('Llamar antes');
        expect(r.details.shipping.address.notes).toBe('Portón verde');
    });

    it('si el pedido no trae fecha límite, se usa la más próxima de sus líneas', () => {
        const sin = { ...pedido, PromisedShippingTime: undefined };
        const r2 = normalizeFalabellaOrder(sin, [
            { ...lineas[0], PromisedShippingTime: '2026-10-15 23:59:59' },
            { ...lineas[0], Sku: 'B', PromisedShippingTime: '2026-10-11 23:59:59' },
        ], 'PEN');
        expect(r2.shipByDate!.toISOString()).toBe('2026-10-12T04:59:59.000Z');
    });

    it('sin nombre en el pedido, usa el de la dirección de envío', () => {
        const r2 = normalizeFalabellaOrder({ ...pedido, CustomerFirstName: undefined, CustomerLastName: undefined }, lineas, 'PEN');
        expect(r2.customerName).toBe('Lucía Paredes');
    });

    it('un pedido casi vacío no rompe: lo que falta queda en null', () => {
        const r2 = normalizeFalabellaOrder({ OrderId: 9 }, [], 'PEN');
        expect(r2.orderNumber).toBe('9');
        expect(r2.customerName).toBeNull();
        expect(r2.shipByDate).toBeNull();
        expect(r2.lines).toEqual([]);
        expect(r2.details.shipping.address.line).toBeNull();
    });
});

describe('venta de Mercado Libre', () => {
    const orden = {
        id: 2000001234, status: 'paid', paid_amount: 180, currency_id: 'PEN',
        buyer: { id: 1, nickname: 'COMPRADOR99', first_name: 'Mario', last_name: 'Vega' },
        shipping: { id: 4455 },
        payments: [{ payment_method_id: 'visa', status: 'approved', installments: 3, total_paid_amount: 180, date_approved: '2026-10-09T15:00:00.000-05:00' }],
        order_items: [{ item: { id: 'MPE111', title: 'Reloj', seller_sku: 'REL-01' }, quantity: 2, unit_price: 90, full_unit_price: 100 }],
    };
    const envio = {
        status: 'ready_to_ship', substatus: 'ready_to_print', tracking_number: 'ML123', tracking_method: 'Mercado Envíos',
        logistic_type: 'cross_docking',
        shipping_option: { name: 'Estándar', estimated_handling_limit: { date: '2026-10-11T23:59:00.000-05:00' }, estimated_delivery_final: { date: '2026-10-15T00:00:00.000-05:00' } },
        receiver_address: { address_line: 'Jr. Lima 55', city: { name: 'Miraflores' }, state: { name: 'Lima' }, country: { name: 'Perú' }, zip_code: '15074', receiver_name: 'Mario Vega', receiver_phone: '988777666', comment: 'Piso 2' },
    };

    it('toma al comprador, las líneas y el pago', () => {
        const r = normalizeMeliOrder(orden, envio);
        expect(r.orderNumber).toBe('2000001234');
        expect(r.customerName).toBe('Mario Vega');
        expect(r.lines[0]).toMatchObject({ sku: 'REL-01', quantity: 2, unitPrice: 90, listPrice: 100, channelItemId: 'MPE111' });
        expect(r.details.payment).toMatchObject({ method: 'visa', installments: 3, paidAmount: 180 });
    });

    it('del envío saca la fecha límite de despacho, el seguimiento y la dirección', () => {
        const r = normalizeMeliOrder(orden, envio);
        expect(r.shipByDate!.toISOString()).toBe('2026-10-12T04:59:00.000Z');
        expect(r.details.shipping.trackingCode).toBe('ML123');
        expect(r.details.shipping.deliveryBy).toBe('2026-10-15T00:00:00.000-05:00');
        expect(r.details.shipping.address).toMatchObject({ line: 'Jr. Lima 55', city: 'Miraflores', region: 'Lima', receiver: 'Mario Vega' });
        expect(r.details.shipping.status).toBe('ready_to_ship (ready_to_print)');
    });

    it('si falla la consulta del envío, la venta se registra igual con lo que ya se sabe', () => {
        const r = normalizeMeliOrder(orden, null);
        expect(r.customerName).toBe('Mario Vega');
        expect(r.shipByDate).toBeNull();
        expect(r.details.shipping.address.line).toBeNull();
    });

    it('sin nombre del comprador, usa su apodo', () => {
        const r = normalizeMeliOrder({ ...orden, buyer: { nickname: 'COMPRADOR99' } }, null);
        expect(r.customerName).toBe('COMPRADOR99');
    });
});

describe('quién ve los datos de contacto', () => {
    it('un lector ve la ciudad pero no teléfono, correo, documento ni calle', () => {
        const r = normalizeFalabellaOrder(pedido, lineas, 'PEN');
        const oculto = ocultarContacto(r.details)!;
        expect(oculto.customer).toMatchObject({ name: 'Lucía Paredes', phone: null, email: null, document: null });
        expect(oculto.shipping.address).toMatchObject({ line: null, postalCode: null, receiver: null, city: 'Surco', region: 'Lima' });
        // lo que no es personal se conserva: estado, seguimiento y fecha límite
        expect(oculto.shipping.trackingCode).toBe('TRK1');
        expect(oculto.shipping.shipBy).not.toBeNull();
    });

    it('no modifica el original', () => {
        const r = normalizeFalabellaOrder(pedido, lineas, 'PEN');
        ocultarContacto(r.details);
        expect(r.details.customer.phone).toBe('999111222');
    });

    it('sin detalles devuelve null', () => {
        expect(ocultarContacto(null)).toBeNull();
    });
});
