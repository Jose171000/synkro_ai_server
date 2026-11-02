import { estadoDeVenta, estadoDeVentaMeli, estadosDePedidoFalabella } from './estado-de-venta';

describe('estado de una venta', () => {
    it('reduce las palabras de Falabella a los cinco estados', () => {
        expect(estadoDeVenta('pending')).toBe('pendiente');
        expect(estadoDeVenta('ready_to_ship')).toBe('pendiente');
        expect(estadoDeVenta('shipped')).toBe('enviado');
        expect(estadoDeVenta('delivered')).toBe('entregado');
        expect(estadoDeVenta('canceled')).toBe('cancelado');
        expect(estadoDeVenta('returned')).toBe('devuelto');
        expect(estadoDeVenta('failed_delivery')).toBe('devuelto');
        expect(estadoDeVenta('')).toBe('pendiente');
    });

    it('con artículos en estados distintos cuenta el menos avanzado, sin contar los cancelados', () => {
        expect(estadoDeVenta('shipped, pending')).toBe('pendiente');
        expect(estadoDeVenta('delivered, shipped')).toBe('enviado');
        expect(estadoDeVenta('canceled, delivered')).toBe('entregado');
        expect(estadoDeVenta('canceled, canceled')).toBe('cancelado');
        expect(estadoDeVenta('canceled, returned')).toBe('devuelto');
    });

    it('lee la lista de estados del pedido de Falabella, venga como texto o como lista', () => {
        expect(estadosDePedidoFalabella({ Statuses: { Status: ['shipped', 'pending'] } })).toBe('shipped, pending');
        expect(estadosDePedidoFalabella({ Statuses: { Status: 'delivered' } })).toBe('delivered');
        expect(estadosDePedidoFalabella({})).toBe('');
    });

    it('Mercado Libre: la cancelación manda; si no, lo dice el envío; sin envío queda pendiente', () => {
        expect(estadoDeVentaMeli('cancelled', 'shipped')).toBe('cancelado');
        expect(estadoDeVentaMeli('paid', 'shipped')).toBe('enviado');
        expect(estadoDeVentaMeli('paid', 'delivered')).toBe('entregado');
        expect(estadoDeVentaMeli('paid', 'ready_to_ship')).toBe('pendiente');
        expect(estadoDeVentaMeli('paid', 'not_delivered')).toBe('devuelto');
        expect(estadoDeVentaMeli('paid', null)).toBe('pendiente');
    });
});
