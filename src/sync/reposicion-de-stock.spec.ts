import { accionDeReposicion, lineaPendienteDeResolver, lineaPorReponer } from './reposicion-de-stock';

describe('accionDeReposicion', () => {
    it('una venta cancelada antes de salir repone el stock al instante', () => {
        expect(accionDeReposicion('pendiente', 'cancelado')).toBe('reponer');
        expect(accionDeReposicion('pendiente', 'devuelto')).toBe('reponer');
    });

    it('una venta que ya salió no repone sola: queda por reponer', () => {
        expect(accionDeReposicion('enviado', 'cancelado')).toBe('por_reponer');
        expect(accionDeReposicion('enviado', 'devuelto')).toBe('por_reponer');
        expect(accionDeReposicion('entregado', 'devuelto')).toBe('por_reponer');
    });

    it('no hace nada si el nuevo estado no es cancelado o devuelto, o si ya lo era', () => {
        expect(accionDeReposicion('pendiente', 'enviado')).toBe('ninguna');
        expect(accionDeReposicion('enviado', 'entregado')).toBe('ninguna');
        expect(accionDeReposicion('cancelado', 'devuelto')).toBe('ninguna');
        expect(accionDeReposicion('devuelto', 'cancelado')).toBe('ninguna');
        expect(accionDeReposicion(null, 'cancelado')).toBe('ninguna');
        expect(accionDeReposicion('pendiente', null)).toBe('ninguna');
    });
});

describe('líneas de una venta', () => {
    const base = { sku: 'A', title: 'A', quantity: 1, unitPrice: 10 };

    it('solo cuentan las líneas a las que la venta descontó stock y que no se resolvieron', () => {
        expect(lineaPendienteDeResolver({ ...base, productId: 'p', stockBefore: 5 })).toBe(true);
        expect(lineaPendienteDeResolver({ ...base, productId: 'p', stockBefore: 0 })).toBe(true);
        expect(lineaPendienteDeResolver({ ...base, productId: 'p' })).toBe(false); // nunca descontó (historial o SKU fuera del catálogo)
        expect(lineaPendienteDeResolver({ ...base, stockBefore: 5 })).toBe(false); // sin producto
        expect(lineaPendienteDeResolver({ ...base, productId: 'p', stockBefore: 5, repuesto: true })).toBe(false);
        expect(lineaPendienteDeResolver({ ...base, productId: 'p', stockBefore: 5, porReponer: true })).toBe(false);
    });

    it('«por reponer» es la que espera confirmación y aún no se repuso', () => {
        expect(lineaPorReponer({ ...base, productId: 'p', stockBefore: 5, porReponer: true })).toBe(true);
        expect(lineaPorReponer({ ...base, productId: 'p', stockBefore: 5, porReponer: true, repuesto: true })).toBe(false);
        expect(lineaPorReponer({ ...base, productId: 'p', stockBefore: 5 })).toBe(false);
    });
});
