import {
    acumularVentas, diasEntre, estimarStock, LineaDeVenta, ordenarGanadores, ritmoPorProducto,
} from './productos-ganadores';

const HOY = '2026-11-06';
const linea = (clave: string, cantidad: number, ingreso: number, fecha: string, pedido = `${clave}-${fecha}-${cantidad}`): LineaDeVenta => ({ clave, cantidad, ingreso, fecha, pedido });

describe('acumularVentas', () => {
    it('suma unidades e ingresos por producto y cuenta cada pedido una vez', () => {
        const r = acumularVentas([
            linea('A', 2, 100, '2026-11-01', 'p1'), linea('A', 1, 50, '2026-11-01', 'p1'), linea('A', 3, 150, '2026-11-02', 'p2'),
            linea('B', 1, 20.555, '2026-11-02', 'p3'),
        ]);
        expect(r.get('A')).toEqual({ clave: 'A', unidades: 6, ingresos: 300, pedidos: 2 });
        expect(r.get('B')).toMatchObject({ unidades: 1, ingresos: 20.56 });
    });
    it('ignora líneas sin producto o sin cantidad', () => {
        expect(acumularVentas([linea('', 1, 10, '2026-11-01'), linea('A', 0, 10, '2026-11-01')]).size).toBe(0);
    });
});

describe('ritmoPorProducto', () => {
    it('mide sobre los últimos 30 días y descarta lo anterior', () => {
        const r = ritmoPorProducto([linea('A', 30, 0, '2026-10-08'), linea('A', 30, 0, '2026-09-01')], HOY);
        // 09-08 queda fuera de la ventana (7 oct – 6 nov); solo cuentan las 30 del 8 de octubre.
        expect(r.get('A')).toEqual({ unidades: 30, dias: 30, porDia: 1 });
    });
    it('un producto que empezó a venderse hace poco se mide sobre los días que lleva vendiéndose', () => {
        const r = ritmoPorProducto([linea('A', 10, 0, '2026-11-04')], HOY);
        expect(r.get('A')?.dias).toBe(3);
        expect(r.get('A')?.porDia).toBeCloseTo(3.33, 2);
    });
});

describe('estimarStock', () => {
    const ritmo = (porDia: number) => ({ unidades: porDia * 30, dias: 30, porDia });

    it('sin stock está agotado y sugiere cubrir 30 días', () => {
        expect(estimarStock(0, ritmo(2), HOY)).toMatchObject({ estado: 'agotado', dias: null, sugerido: 60, recomendacion: 'Sin stock: repón ya' });
    });
    it('hasta 7 días es crítico, hasta 15 es pronto y más es suficiente', () => {
        expect(estimarStock(6, ritmo(1.4), HOY)).toMatchObject({ estado: 'critico', dias: 4.3, agotaEl: '2026-11-10', recomendacion: 'Repón ya' });
        expect(estimarStock(10, ritmo(1), HOY)).toMatchObject({ estado: 'pronto', dias: 10 });
        expect(estimarStock(20, ritmo(1), HOY)).toMatchObject({ estado: 'suficiente', sugerido: 0 });
    });
    it('sugiere lo que falta para 30 días, redondeado hacia arriba', () => {
        expect(estimarStock(5, ritmo(1.5), HOY).sugerido).toBe(40); // 45 - 5
    });
    it('con stock y sin ventas no hay fecha de agotamiento', () => {
        expect(estimarStock(19, ritmo(0), HOY)).toMatchObject({ estado: 'sin_ventas', dias: null, agotaEl: null, sugerido: 0 });
        expect(estimarStock(19, null, HOY).estado).toBe('sin_ventas');
    });
    it('un stock negativo o sin dato cuenta como agotado', () => {
        expect(estimarStock(-3, ritmo(1), HOY).estado).toBe('agotado');
        expect(estimarStock(null, ritmo(1), HOY).estado).toBe('agotado');
    });
});

describe('ordenarGanadores', () => {
    const item = (n: string, unidades: number, ingresos: number, stock: number, porDia: number) => ({
        n, unidades, ingresos, stockEstimado: estimarStock(stock, { unidades: porDia * 30, dias: 30, porDia }, HOY),
    });
    const lista = [item('lento', 5, 900, 50, 0.5), item('rapido', 40, 400, 6, 1.4), item('agotado', 10, 100, 0, 1), item('sinventas', 1, 10, 9, 0)];

    it('por unidades', () => expect(ordenarGanadores(lista, 'units').map((i) => i.n)).toEqual(['rapido', 'agotado', 'lento', 'sinventas']));
    it('por ingresos', () => expect(ordenarGanadores(lista, 'revenue').map((i) => i.n)).toEqual(['lento', 'rapido', 'agotado', 'sinventas']));
    it('por el que se agota antes: agotados primero, sin ventas al final', () =>
        expect(ordenarGanadores(lista, 'days').map((i) => i.n)).toEqual(['agotado', 'rapido', 'lento', 'sinventas']));
});

describe('diasEntre', () => {
    it('cuenta ambos extremos', () => {
        expect(diasEntre('2026-11-06', '2026-11-06')).toBe(1);
        expect(diasEntre('2026-11-04', '2026-11-06')).toBe(3);
    });
});
