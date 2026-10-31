import { firmaDePromo, preciosParaCanal } from './precios-por-canal';

const producto = (extra: any = {}) => ({ price: 100, salePrice: null, saleStartDate: null, saleEndDate: null, ...extra });

describe('precios que se envían a un canal', () => {
    it('sin nada propio usa el precio y el descuento del producto', () => {
        const r = preciosParaCanal(producto({ salePrice: 80, saleStartDate: '2026-11-01', saleEndDate: '2026-11-30' }), {});
        expect(r.price).toBe(100);
        expect(r.promo).toEqual({ salePrice: 80, start: '2026-11-01', end: '2026-11-30' });
        expect(r.origen).toEqual({ price: 'producto', promo: 'producto' });
    });

    it('lo fijado para el canal gana al producto', () => {
        const r = preciosParaCanal(producto({ salePrice: 80 }), { priceOverride: 120, salePriceOverride: 90, saleEndOverride: '2026-12-01' });
        expect(r.price).toBe(120);
        expect(r.promo).toEqual({ salePrice: 90, start: null, end: '2026-12-01' });
        expect(r.origen).toEqual({ price: 'propio', promo: 'propio' });
    });

    it('un producto importado sin descuento propio no quita el que el canal ya muestra', () => {
        const r = preciosParaCanal(producto(), { salePrice: 85 });
        expect(r.promo).toEqual({ salePrice: 85, start: null, end: null });
        expect(r.origen.promo).toBe('canal');
    });

    it('un descuento que no es menor que el precio no cuenta', () => {
        expect(preciosParaCanal(producto({ salePrice: 100 }), {}).promo).toBeNull();
        expect(preciosParaCanal(producto(), { salePriceOverride: 130 }).promo).toBeNull();
    });

    it('sin descuento en ningún lado no hay promoción', () => {
        const r = preciosParaCanal(producto(), { priceOverride: null, salePrice: null });
        expect(r.promo).toBeNull();
        expect(r.origen.promo).toBeNull();
        expect(firmaDePromo(r.promo)).toBe('');
    });
});
