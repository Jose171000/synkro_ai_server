import { agruparVentas } from './ganadoras';

/**
 * Productos ganadores: por defecto ordenados por ingresos; el canal más fuerte de cada producto sale de lo que ingresó
 * en cada uno; y la lista contiene los mejores por ingresos y por unidades para poder cambiar el orden sin otra consulta.
 */
const fila = (sku: string, marketplace: string, unidades: number, importe: number, title = `Producto ${sku}`) => ({ sku, title, marketplace, unidades, importe });

describe('agruparVentas', () => {
    it('suma los canales de un mismo SKU y marca el canal donde más ingresó, con su porcentaje', () => {
        const [p] = agruparVentas([
            fila('A', 'falabella', 8, 800),
            fila('A', 'mercadolibre', 2, 200),
        ]);
        expect(p).toMatchObject({ sku: 'A', unidades: 10, importe: 1000 });
        expect(p.canal).toEqual({ marketplace: 'falabella', unidades: 8, importe: 800, porcentaje: 80 });
        expect(p.canales.map((c) => [c.marketplace, c.porcentaje])).toEqual([['falabella', 80], ['mercadolibre', 20]]);
    });

    it('el canal más fuerte es el que más ingresó, no el que más unidades vendió', () => {
        const [p] = agruparVentas([
            fila('A', 'mercadolibre', 20, 400),
            fila('A', 'falabella', 5, 900),
        ]);
        expect(p.canal?.marketplace).toBe('falabella');
    });

    it('sin importes (precios en cero) el canal se decide por unidades', () => {
        const [p] = agruparVentas([fila('A', 'woocommerce', 3, 0), fila('A', 'falabella', 9, 0)]);
        expect(p.canal).toMatchObject({ marketplace: 'falabella', porcentaje: 75 });
    });

    it('ordena por ingresos de forma predeterminada', () => {
        const r = agruparVentas([fila('BARATO', 'falabella', 100, 500), fila('CARO', 'falabella', 5, 2000), fila('MEDIO', 'falabella', 20, 900)]);
        expect(r.map((x) => x.sku)).toEqual(['CARO', 'MEDIO', 'BARATO']);
    });

    it('incluye los mejores por unidades aunque no estén entre los de más ingresos', () => {
        const filas = [
            ...['A', 'B', 'C'].map((s, i) => fila(s, 'falabella', 1, 1000 - i)), // ingresos altos, pocas unidades
            fila('POPULAR', 'falabella', 500, 50),                                // muchas unidades, poco dinero
        ];
        const r = agruparVentas(filas, 3);
        expect(r.map((x) => x.sku).sort()).toEqual(['A', 'B', 'C', 'POPULAR']);
        const porUnidades = [...r].sort((a, b) => b.unidades - a.unidades);
        expect(porUnidades[0].sku).toBe('POPULAR');
    });

    it('ignora filas sin SKU y no repite productos', () => {
        const r = agruparVentas([fila('', 'falabella', 5, 50), fila('A', 'falabella', 1, 10), fila('A', 'falabella', 1, 10)], 5);
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ sku: 'A', unidades: 2, importe: 20 });
    });
});
