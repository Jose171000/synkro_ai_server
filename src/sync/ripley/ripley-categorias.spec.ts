import { atributosParaGuardar, atributosPorCategoria, hojasDeRipley, listasDeValores, MAX_OPCIONES_EN_LINEA, textoParaVector } from './ripley-categorias';

const ARBOL = [
    { code: 'R14', label: 'MALETERÍA, BOLSOS Y CARTERAS', level: 1, parent_code: '' },
    { code: 'R1411', label: 'LONCHERAS', level: 2, parent_code: 'R14' },
    { code: 'R1408', label: 'CARTERAS, BOLSOS Y MORRALES', level: 2, parent_code: 'R14' },
    { code: 'R19', label: 'LIBRERÍA ESCOLAR', level: 1, parent_code: '' },
    { code: 'R1901', label: 'ÚTILES ESCOLARES', level: 2, parent_code: 'R19' },
    { code: 'R190101', label: 'LONCHERAS', level: 3, parent_code: 'R1901' },
];

describe('hojasDeRipley', () => {
    it('solo devuelve las categorías donde se publica (las que no son padre de otra)', () => {
        expect(hojasDeRipley(ARBOL).map((h) => h.codigo).sort()).toEqual(['R1408', 'R1411', 'R190101']);
    });

    it('arma la ruta completa, así dos «LONCHERAS» se distinguen', () => {
        const rutas = Object.fromEntries(hojasDeRipley(ARBOL).map((h) => [h.codigo, h.ruta]));
        expect(rutas['R1411']).toBe('MALETERÍA, BOLSOS Y CARTERAS › LONCHERAS');
        expect(rutas['R190101']).toBe('LIBRERÍA ESCOLAR › ÚTILES ESCOLARES › LONCHERAS');
    });

    it('ignora filas sin código o sin nombre y no se cuelga con un ciclo', () => {
        const raros = [{ code: 'A', label: 'A', parent_code: 'B' }, { code: 'B', label: 'B', parent_code: 'A' }, { label: 'sin código' }, { code: 'X' }];
        expect(() => hojasDeRipley(raros as any)).not.toThrow();
    });

    it('un árbol vacío no da categorías', () => {
        expect(hojasDeRipley([])).toEqual([]);
        expect(hojasDeRipley(undefined as any)).toEqual([]);
    });
});

describe('textoParaVector', () => {
    it('usa la ruta completa sin los separadores', () => {
        expect(textoParaVector({ codigo: 'R1411', nombre: 'LONCHERAS', ruta: 'MALETERÍA, BOLSOS Y CARTERAS › LONCHERAS' })).toBe('MALETERÍA, BOLSOS Y CARTERAS LONCHERAS');
    });
});

describe('atributos de una categoría', () => {
    const atributos = [
        { code: 'modelo', label: 'Modelo', type: 'TEXT', hierarchy_code: 'R1411', required: false, requirement_level: 'OPTIONAL' },
        { code: 'color_80', label: 'Color', type: 'LIST', type_parameter: 'color_80', hierarchy_code: 'R1411', required: true, requirement_level: 'REQUIRED', variant: true },
        { code: 'escolar', label: 'Escolar', type: 'LIST', type_parameter: 'escolar', hierarchy_code: 'R1411', required: true, requirement_level: 'REQUIRED' },
        { code: 'capacidad', label: 'Capacidad', type: 'TEXT', hierarchy_code: 'R1411', required: false, requirement_level: 'RECOMMENDED' },
        { code: 'otro', label: 'Otro', type: 'TEXT', hierarchy_code: 'R1408', required: false },
    ];
    const muchos = Array.from({ length: MAX_OPCIONES_EN_LINEA + 10 }, (_, i) => `Color ${i}`);
    const listas = new Map<string, string[]>([['color_80', muchos], ['escolar', ['Sí', 'No']]]);

    it('agrupa por categoría', () => {
        const m = atributosPorCategoria(atributos);
        expect(m.get('R1411')).toHaveLength(4);
        expect(m.get('R1408')).toHaveLength(1);
    });

    it('guarda primero los obligatorios, luego recomendados y opcionales', () => {
        const g = atributosParaGuardar(atributosPorCategoria(atributos).get('R1411')!, listas);
        expect(g.map((a) => a.name)).toEqual(['color_80', 'escolar', 'capacidad', 'modelo']);
        expect(g.filter((a) => a.isRequired).map((a) => a.name)).toEqual(['color_80', 'escolar']);
    });

    it('una lista corta va dentro del atributo; una larga solo se referencia por su código', () => {
        const g = Object.fromEntries(atributosParaGuardar(atributosPorCategoria(atributos).get('R1411')!, listas).map((a) => [a.name, a]));
        expect(g.escolar.options).toEqual(['Sí', 'No']);
        expect(g.color_80.options).toBeUndefined();
        expect(g.color_80.listCode).toBe('color_80');
    });

    it('marca el atributo de variante y el texto libre no lleva lista', () => {
        const g = Object.fromEntries(atributosParaGuardar(atributosPorCategoria(atributos).get('R1411')!, listas).map((a) => [a.name, a]));
        expect(g.color_80.isVariant).toBe(true);
        expect(g.escolar.isVariant).toBeUndefined();
        expect(g.modelo.listCode).toBeUndefined();
        expect(g.modelo.options).toBeUndefined();
    });

    it('una categoría sin atributos da una lista vacía', () => {
        expect(atributosParaGuardar([], listas)).toEqual([]);
    });
});

describe('listasDeValores', () => {
    it('usa la etiqueta de cada valor, sin repetidos ni vacíos', () => {
        const m = listasDeValores([{ code: 'escolar', values: [{ code: 'Sí', label: 'Sí' }, { code: 'No', label: 'No' }, { code: 'No', label: 'No' }, { label: ' ' }] }, { label: 'sin código' }] as any);
        expect(m.get('escolar')).toEqual(['Sí', 'No']);
        expect(m.size).toBe(1);
    });
});
