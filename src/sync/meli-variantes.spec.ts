import { planearGruposDeMeli, valoresDeVariacion } from './meli/variantes-meli';

/**
 * Mercado Libre trae el eje y el valor de cada variación: los ejes salen de ahí, sin deducir nada. Lo que se protege:
 * solo los atributos que TODAS las variaciones tienen y que cambian son ejes, cada variante conserva sus fotos, y lo que
 * no se puede decidir con certeza no se agrupa.
 */
const combos = (...pares: [string, string][]) => pares.map(([name, value_name]) => ({ id: name.toUpperCase(), name, value_name }));
const variacion = (id: number, sku: string, atributos: [string, string][], over: any = {}) => ({
    id, price: 40, available_quantity: 3, seller_custom_field: sku, attribute_combinations: combos(...atributos), picture_ids: [`foto-${id}`], ...over,
});
const item = (variaciones: any[], over: any = {}) => ({
    id: 'MPE900', title: 'Polo Básico Algodón', status: 'active', price: 40, available_quantity: 9,
    pictures: variaciones.map((v) => ({ id: `foto-${v.id}`, secure_url: `https://img/${v.id}.jpg` })), ...over, variations: variaciones,
});

describe('valoresDeVariacion', () => {
    it('lee el nombre y el valor de cada atributo de la variación', () => {
        expect(valoresDeVariacion(variacion(1, 'A', [['Color', 'Rojo'], ['Talla', 'M']]))).toEqual({ Color: 'Rojo', Talla: 'M' });
    });
    it('ignora atributos sin nombre o sin valor', () => {
        expect(valoresDeVariacion({ attribute_combinations: [{ name: 'Color', value_name: '' }, { value_name: 'X' }] })).toEqual({});
    });
});

describe('planearGruposDeMeli', () => {
    it('una publicación con variaciones por color y talla es un grupo con dos ejes', () => {
        const { grupos, sinResolver } = planearGruposDeMeli([item([
            variacion(1, 'POLO-RJ-S', [['Color', 'Rojo'], ['Talla', 'S']]),
            variacion(2, 'POLO-RJ-M', [['Color', 'Rojo'], ['Talla', 'M']]),
            variacion(3, 'POLO-AZ-S', [['Color', 'Azul'], ['Talla', 'S']]),
        ])]);
        expect(sinResolver).toEqual([]);
        expect(grupos).toHaveLength(1);
        expect(grupos[0]).toMatchObject({ parentSku: 'MPE900', name: 'Polo Básico Algodón' });
        expect(grupos[0].axes).toEqual([{ name: 'Color', values: ['Rojo', 'Azul'] }, { name: 'Talla', values: ['S', 'M'] }]);
        expect(grupos[0].variants).toEqual([
            { sellerSku: 'POLO-RJ-S', values: { Color: 'Rojo', Talla: 'S' } },
            { sellerSku: 'POLO-RJ-M', values: { Color: 'Rojo', Talla: 'M' } },
            { sellerSku: 'POLO-AZ-S', values: { Color: 'Azul', Talla: 'S' } },
        ]);
    });

    it('un atributo igual en todas las variaciones no es un eje', () => {
        const { grupos } = planearGruposDeMeli([item([
            variacion(1, 'A', [['Color', 'Rojo'], ['Marca', 'Acme']]),
            variacion(2, 'B', [['Color', 'Azul'], ['Marca', 'Acme']]),
        ])]);
        expect(grupos[0].axes.map((e) => e.name)).toEqual(['Color']);
    });

    it('una publicación sin variaciones, o con una sola, es un producto simple', () => {
        expect(planearGruposDeMeli([item([]), item([variacion(1, 'A', [['Color', 'Rojo']])])]).grupos).toEqual([]);
    });

    it('las variaciones sin SKU no cuentan; con menos de dos con SKU no hay grupo', () => {
        const { grupos } = planearGruposDeMeli([item([variacion(1, 'A', [['Color', 'Rojo']]), variacion(2, '', [['Color', 'Azul']])])]);
        expect(grupos).toEqual([]);
        const dos = planearGruposDeMeli([item([variacion(1, 'A', [['Color', 'Rojo']]), variacion(2, 'B', [['Color', 'Azul']]), variacion(3, '', [['Color', 'Verde']])])]);
        expect(dos.grupos[0].variants.map((v) => v.sellerSku)).toEqual(['A', 'B']);
    });

    it('si las variaciones no traen atributos, no se agrupa y se explica, con las fichas para estructurarlas a mano', () => {
        const { grupos, sinResolver } = planearGruposDeMeli([item([variacion(1, 'A', []), variacion(2, 'B', [])])]);
        expect(grupos).toEqual([]);
        expect(sinResolver[0]).toMatchObject({ parentSku: 'MPE900', skus: ['A', 'B'] });
        expect(sinResolver[0].motivo).toMatch(/no traen atributos/);
        expect(sinResolver[0].fichas).toEqual([
            { sku: 'A', nombre: 'Polo Básico Algodón', imagen: 'https://img/1.jpg' },
            { sku: 'B', nombre: 'Polo Básico Algodón', imagen: 'https://img/2.jpg' },
        ]);
    });

    it('si falta un atributo en alguna variación, ese atributo no se usa como eje', () => {
        const { grupos } = planearGruposDeMeli([item([
            variacion(1, 'A', [['Color', 'Rojo'], ['Talla', 'S']]),
            variacion(2, 'B', [['Color', 'Azul']]),
        ])]);
        expect(grupos[0].axes.map((e) => e.name)).toEqual(['Color']);
    });

    it('más de tres atributos que cambian: no se agrupa', () => {
        const { grupos, sinResolver } = planearGruposDeMeli([item([
            variacion(1, 'A', [['Color', 'Rojo'], ['Talla', 'S'], ['Material', 'Algodón'], ['Estilo', 'Liso']]),
            variacion(2, 'B', [['Color', 'Azul'], ['Talla', 'M'], ['Material', 'Lino'], ['Estilo', 'Rayado']]),
        ])]);
        expect(grupos).toEqual([]);
        expect(sinResolver[0].motivo).toMatch(/más de 3 atributos/);
    });

    it('valores iguales con otra escritura (Rojo / rojo) son el mismo valor: ese atributo no distingue y no es eje', () => {
        const { grupos } = planearGruposDeMeli([item([
            variacion(1, 'A', [['Color', 'Rojo'], ['Talla', 'S']]),
            variacion(2, 'B', [['Color', 'rojo'], ['Talla', 'M']]),
        ])]);
        expect(grupos[0].axes.map((e) => e.name)).toEqual(['Talla']);
    });
});
