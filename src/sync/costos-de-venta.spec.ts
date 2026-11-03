import { costosFalabella, costosManual, costosMeli } from './costos-de-venta';

describe('costos de envío y cupones de Falabella', () => {
    it('el envío que pagó el cliente se suma por artículo (caso real: S/ 15 + envío S/ 9.90)', () => {
        const c = costosFalabella({ ShippingFeeTotal: '9.90' }, [{ ItemPrice: '15.00', PaidPrice: '15.00', ShippingAmount: '9.90', ShippingServiceCost: '0.00', DeliveryMethod: 'Home_delivery' }]);
        expect(c).toMatchObject({ shippingPaid: 9.9, shippingType: 'comprador', shippingSellerCost: null, discountAmount: 0 });
    });

    it('un retiro en tienda no tiene envío: no es envío gratis cubierto por el vendedor', () => {
        const c = costosFalabella({}, [{ ItemPrice: '30.00', PaidPrice: '30.00', ShippingAmount: '0.00', ShippingServiceCost: '0.00', DeliveryMethod: 'Collect' }]);
        expect(c).toMatchObject({ shippingPaid: 0, shippingType: 'retiro', shippingSellerCost: null });
    });

    it('entrega a domicilio con envío en 0 es envío gratis para el cliente, sin costo conocido', () => {
        const c = costosFalabella({}, [{ ShippingAmount: '0.00', ShippingServiceCost: '0.00', DeliveryMethod: 'Home_delivery' }]);
        expect(c).toMatchObject({ shippingType: 'gratis', shippingSellerCost: null });
    });

    it('si el artículo informa un costo de servicio y el cliente no pagó envío, lo cubre el vendedor', () => {
        const c = costosFalabella({}, [{ ShippingAmount: '0.00', ShippingServiceCost: '7.50', DeliveryMethod: 'Home_delivery' }]);
        expect(c).toMatchObject({ shippingType: 'gratis', shippingSellerCost: 7.5 });
    });

    it('sin datos del método de entrega no se inventa nada', () => {
        expect(costosFalabella({}, [])).toMatchObject({ shippingPaid: 0, shippingType: 'sin_dato', shippingSellerCost: null });
    });

    it('el cupón es lo que el comprador pagó de menos, y se sabe la parte del vendedor si el canal da el porcentaje', () => {
        const c = costosFalabella({}, [{ ItemPrice: '145.00', PaidPrice: '136.90', VoucherAmountDetails: { CmrDiscount: '8.10', CmrDiscountSellerFundedPct: '50' } }]);
        expect(c.discountAmount).toBe(8.1);
        expect(c.discountSellerFunded).toBe(4.05);
        const otro = costosFalabella({}, [{ ItemPrice: '100.00', PaidPrice: '90.00', VoucherAmountDetails: { OtherDiscount: '10.00' } }]);
        expect(otro).toMatchObject({ discountAmount: 10, discountSellerFunded: null });
    });
});

describe('costos de envío y cupones de Mercado Libre', () => {
    it('envío gratis para el comprador: el costo de lista del envío es lo que cubre el vendedor (caso real: S/ 33.60)', () => {
        const c = costosMeli(
            { total_amount: 179, paid_amount: 179, payments: [{ shipping_cost: 0 }], coupon: { amount: 35 } },
            { lead_time: { cost: 0, cost_type: 'free', list_cost: 33.6 } },
        );
        expect(c).toMatchObject({ shippingPaid: 0, shippingType: 'gratis', shippingSellerCost: 33.6, discountAmount: 35, discountSellerFunded: null });
    });

    it('envío pagado por el comprador: sale de lo pagado en el envío o de la diferencia con los productos', () => {
        expect(costosMeli({ total_amount: 35, paid_amount: 45.9, payments: [{ shipping_cost: 10.9 }] }, { lead_time: { cost: 10.9, cost_type: 'charged', list_cost: 10.9 } }))
            .toMatchObject({ shippingPaid: 10.9, shippingType: 'comprador', shippingSellerCost: null });
        expect(costosMeli({ total_amount: 35, paid_amount: 45.9, payments: [{}] }, null)).toMatchObject({ shippingPaid: 10.9, shippingType: 'comprador' });
    });

    it('con dos pagos que repiten el envío, no se cuenta dos veces (caso real: S/ 10.90 salía 21.80)', () => {
        expect(costosMeli({ total_amount: 35, paid_amount: 45.9, payments: [{ shipping_cost: 10.9, status: 'approved' }, { shipping_cost: 10.9, status: 'approved' }] }, null).shippingPaid).toBe(10.9);
        expect(costosMeli({ total_amount: 35, paid_amount: 45.9, payments: [{ shipping_cost: 10.9, status: 'rejected' }, { shipping_cost: 10.9, status: 'approved' }] }, null).shippingPaid).toBe(10.9);
    });

    it('una venta sin envío o sin datos del envío queda sin dato; una cancelada (pagado 0) no inventa envío', () => {
        expect(costosMeli({ total_amount: 79.9, paid_amount: 79.9 }, null)).toMatchObject({ shippingPaid: 0, shippingType: 'sin_dato', discountAmount: 0 });
        expect(costosMeli({ total_amount: 79.9, paid_amount: 0, payments: [{ shipping_cost: 0 }] }, null).shippingPaid).toBe(0);
    });
});

describe('costos de una venta manual', () => {
    it('cobrado al cliente, cubierto por ti o ninguno', () => {
        expect(costosManual(12, 0)).toMatchObject({ shippingPaid: 12, shippingType: 'comprador', shippingSellerCost: null });
        expect(costosManual(0, 9)).toMatchObject({ shippingPaid: 0, shippingType: 'gratis', shippingSellerCost: 9 });
        expect(costosManual(0, 0)).toMatchObject({ shippingType: 'sin_dato', shippingSellerCost: null });
        expect(costosManual(10, 4)).toMatchObject({ shippingType: 'comprador', shippingSellerCost: 4 });
    });
});
