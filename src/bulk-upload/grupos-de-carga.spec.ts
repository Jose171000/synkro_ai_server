import { armarGrupos, codigosConVariantes, FilaConEjes } from './grupos-de-carga';
import { chunkPorFamilia } from '../sync/falabella/falabella-product-xml';

/** Una fila como la lee el controlador: `ejes` es [[eje_1, valor_1], [eje_2, valor_2], …]. */
const fila = (i: number, grupo: string, sku: string, ...ejes: [string, string][]): FilaConEjes => ({
    i, grupo, sku, ejes: [0, 1, 2].map((k) => ({ nombre: ejes[k]?.[0] ?? '', valor: ejes[k]?.[1] ?? '' })),
});

describe('carga masiva: productos con variantes', () => {
    it('las filas con el mismo sku_padre y ejes forman un grupo; el nombre del eje basta en la primera fila', () => {
        const r = armarGrupos([
            fila(0, 'GOLDEN-PREM', 'GOLD-15P', ['Medida', '1.5 plazas'], ['Color', 'Blanco']),
            fila(1, 'golden-prem', 'GOLD-2P', ['', '2 plazas'], ['', 'Blanco']),
            fila(2, 'GOLDEN-PREM', '', ['medida', 'Queen'], ['', 'Blanco']),
            fila(3, '', 'ALM-01'),
        ]);
        expect(r.errores).toEqual([]);
        expect(r.sueltas.map((f) => f.sku)).toEqual(['ALM-01']);
        expect(r.grupos).toHaveLength(1);
        const g = r.grupos[0];
        expect(g.codigo).toBe('GOLDEN-PREM');
        expect(g.ejes).toEqual([{ name: 'Medida', values: ['1.5 plazas', '2 plazas', 'Queen'] }, { name: 'Color', values: ['Blanco'] }]);
        expect(g.valores[2]).toEqual({ Medida: 'Queen', Color: 'Blanco' });
    });

    it('un sku_padre sin ejes sigue como antes: filas sueltas que solo comparten la categoría', () => {
        const r = armarGrupos([fila(0, 'P1', 'A'), fila(1, 'P1', 'B')]);
        expect(r.grupos).toEqual([]);
        expect(r.sueltas).toHaveLength(2);
        expect(codigosConVariantes([fila(0, 'P1', 'A'), fila(1, 'P2', 'B', ['Talla', 'M'])])).toEqual(new Set(['p2']));
    });

    it('rechaza el grupo entero si falta un valor, con la fila del Excel', () => {
        const r = armarGrupos([fila(0, 'G', 'A', ['Medida', '2 plazas']), fila(1, 'G', 'B')]);
        expect(r.grupos).toEqual([]);
        expect(r.errores[0].filas).toEqual([0, 1]);
        expect(r.errores[0].motivo).toContain('fila 3');
        expect(r.errores[0].motivo).toContain('«Medida»');
    });

    it('rechaza dos filas que son la misma variante', () => {
        const r = armarGrupos([fila(0, 'G', 'A', ['Medida', 'Queen']), fila(1, 'G', 'B', ['', 'queen'])]);
        expect(r.errores[0].motivo).toMatch(/filas 2 y 3 son la misma variante/);
    });

    it('rechaza un eje escrito distinto entre filas y un valor sin eje', () => {
        expect(armarGrupos([fila(0, 'G', 'A', ['Medida', '1']), fila(1, 'G', 'B', ['Talla', '2'])]).errores[0].motivo).toMatch(/eje_1 dice «Medida».*«Talla»/);
        expect(armarGrupos([fila(0, 'G', 'A', ['Medida', '1'], ['', 'Rojo'])]).errores[0].motivo).toMatch(/valor_2 pero falta el nombre del eje/);
    });

    it('respeta el límite de 100 variantes', () => {
        const filas = Array.from({ length: 101 }, (_, i) => fila(i, 'G', `S${i}`, ['Talla', `T${i}`]));
        expect(armarGrupos(filas).errores[0].motivo).toMatch(/admite hasta 100/);
    });

    it('un error en un grupo no afecta a los demás grupos', () => {
        const r = armarGrupos([
            fila(0, 'MALO', 'A', ['Medida', 'X']), fila(1, 'MALO', 'B', ['', 'X']),
            fila(2, 'BUENO', 'C', ['Medida', 'X']), fila(3, 'BUENO', 'D', ['', 'Y']),
        ]);
        expect(r.grupos.map((g) => g.codigo)).toEqual(['BUENO']);
        expect(r.errores.map((e) => e.codigo)).toEqual(['MALO']);
    });
});

describe('envío a Falabella sin partir familias', () => {
    it('una familia va entera en un mismo envío aunque se pase del tamaño de la tanda', () => {
        const items = ['a', 'b', 'G1', 'G1', 'G1', 'c', 'G2', 'G2'];
        const lotes = chunkPorFamilia(items.map((f, i) => ({ f, i })), (x) => (x.f.startsWith('G') ? x.f : `suelto-${x.i}`), 4);
        expect(lotes.map((l) => l.map((x) => x.f))).toEqual([['a', 'b'], ['G1', 'G1', 'G1', 'c'], ['G2', 'G2']]);
    });
});

describe('descuento enviado a Falabella', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { descuentoParaFalabella } = require('../sync/falabella/falabella-product-xml');
    it('sin fecha de inicio empieza hoy; con fechas va tal cual', () => {
        expect(descuentoParaFalabella(390, { salePrice: 290, saleEnd: '2026-12-31' }, '2026-11-20')).toEqual({ salePrice: 290, start: '2026-11-20', end: '2026-12-31' });
        expect(descuentoParaFalabella(390, { salePrice: 290, saleStart: '2026-12-01', saleEnd: '2026-12-31' }, '2026-11-20')).toEqual({ salePrice: 290, start: '2026-12-01', end: '2026-12-31' });
    });
    it('sin fecha de fin no se envía el descuento (Falabella rechazaría la ficha entera)', () => {
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(descuentoParaFalabella(390, { salePrice: 290 }, '2026-11-20')).toBeNull();
        expect(descuentoParaFalabella(390, { salePrice: 400, saleEnd: '2026-12-31' }, '2026-11-20')).toBeNull();
    });
});
