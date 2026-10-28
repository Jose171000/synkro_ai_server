import { descripcionParaYavendio, estadoDeVariante, PlanInvalido, planificarYavendio } from './yavendio-plan';

const producto = (extra: any = {}) => ({ id: 'p1', sku: 'KI-0001', name: 'Polo', price: 49.9, stock: 3, images: [{ url: 'https://cdn/x.jpg' }], ...extra });

describe('Yavendió: plan de publicación', () => {
    it('un producto simple usa la opción «Presentación: Estándar» (Yavendió exige al menos una opción)', () => {
        const plan = planificarYavendio([producto()]);
        expect(plan.options).toEqual([{ name: 'Presentación', values: ['Estándar'] }]);
        expect(plan.variants).toHaveLength(1);
        expect(plan.variants[0]).toMatchObject({ sku: 'KI-0001', name: 'Polo', price: 49.9, status: 'available', optionValues: [{ option: 'Presentación', value: 'Estándar' }] });
    });

    it('un grupo da una opción por eje, solo con los valores usados, y una variante por combinación', () => {
        const grupo = { name: 'Polo Negro', axes: [{ name: 'Talla', values: ['S', 'M', 'L'] }, { name: 'Color', values: ['Negro', 'Rojo'] }] };
        const plan = planificarYavendio(
            [
                producto({ id: 'a', sku: 'P-S', variantValues: { Talla: 'S', Color: 'Negro' } }),
                producto({ id: 'b', sku: 'P-M', variantValues: { Talla: 'M', Color: 'Negro' } }),
            ],
            grupo,
        );
        expect(plan.name).toBe('Polo Negro');
        expect(plan.options).toEqual([{ name: 'Talla', values: ['S', 'M'] }, { name: 'Color', values: ['Negro'] }]);
        expect(plan.variants.map((v) => v.name)).toEqual(['Polo Negro - S / Negro', 'Polo Negro - M / Negro']);
        expect(plan.variants[1].optionValues).toEqual([{ option: 'Talla', value: 'M' }, { option: 'Color', value: 'Negro' }]);
    });

    it('sin stock la variante queda «no disponible»; pausada por el usuario también', () => {
        expect(estadoDeVariante(0)).toBe('not_available');
        expect(estadoDeVariante(5)).toBe('available');
        expect(estadoDeVariante(5, true)).toBe('not_available');
    });

    it('rechaza lo que Yavendió rechazaría: sin precio, SKU repetido, valor de eje faltante, combinación repetida', () => {
        const grupo = { name: 'G', axes: [{ name: 'Talla', values: ['S', 'M'] }] };
        expect(() => planificarYavendio([producto({ price: null })])).toThrow(/precio/);
        expect(() => planificarYavendio([producto({ id: 'a', variantValues: { Talla: 'S' } }), producto({ id: 'b', variantValues: { Talla: 'M' } })], grupo)).toThrow(/repetido/);
        expect(() => planificarYavendio([producto({ variantValues: {} })], grupo)).toThrow(/Ninguna variante tiene valores/);
        expect(() => planificarYavendio([producto({ id: 'a', sku: 'A', variantValues: { Talla: 'S' } }), producto({ id: 'b', sku: 'B', variantValues: {} })], grupo)).toThrow(/falta el valor/);
        expect(() => planificarYavendio([producto({ id: 'a', sku: 'A', variantValues: { Talla: 'S' } }), producto({ id: 'b', sku: 'B', variantValues: { Talla: 's' } })], grupo)).toThrow(PlanInvalido);
    });

    it('solo manda fotos https, sin repetir y hasta 8', () => {
        const images = [{ url: 'http://a/1.jpg' }, { url: 'https://a/2.jpg' }, { url: 'https://a/2.jpg' }, ...Array.from({ length: 12 }, (_, i) => ({ url: `https://a/f${i}.jpg` }))];
        const plan = planificarYavendio([producto({ images })]);
        expect(plan.variants[0].images).toHaveLength(8);
        expect(plan.variants[0].images[0]).toBe('https://a/2.jpg');
        expect(plan.variants[0].images.every((u) => u.startsWith('https://'))).toBe(true);
    });

    it('la descripción va en texto simple y no pasa de 500 caracteres', () => {
        const html = `<p>${'palabra '.repeat(200)}</p><img src="x">`;
        const d = descripcionParaYavendio(html);
        expect(d.length).toBeLessThanOrEqual(500);
        expect(d).not.toMatch(/<|>/);
        expect(d.endsWith('…')).toBe(true);
        expect(descripcionParaYavendio('<p>Corta</p>')).toBe('Corta');
    });
});
