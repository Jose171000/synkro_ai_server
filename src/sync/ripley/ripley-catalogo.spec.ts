import { camposDeCategoria, ejesDeVariante, MAX_LISTA_EN_CAMPO, validarAtributosEscritos } from './ripley-catalogo';

const larga = Array.from({ length: MAX_LISTA_EN_CAMPO + 5 }, (_, i) => `Tipo ${i}`);
const listas = new Map<string, string[]>([['color_80', ['Beige', 'Marrón', 'Negro']], ['escolar', ['Sí', 'No']], ['tipo_product', larga]]);
const atributos = [
    { name: 'color_80', description: 'Color — color del producto', example: '', isRequired: true, listCode: 'color_80', isVariant: true, valueType: 'LIST', level: 'REQUIRED' },
    { name: 'tipo_product', description: 'Tipo de producto', example: '', isRequired: true, listCode: 'tipo_product', valueType: 'LIST', level: 'REQUIRED' },
    { name: 'escolar', description: 'Escolar', example: '', isRequired: true, listCode: 'escolar', valueType: 'LIST', level: 'REQUIRED' },
    { name: 'modelo', description: 'Modelo', example: '', isRequired: false, valueType: 'TEXT', level: 'OPTIONAL' },
];

describe('camposDeCategoria', () => {
    const campos = Object.fromEntries(camposDeCategoria(atributos as any, listas).map((c) => [c.name, c]));

    it('una lista corta va completa y una larga se marca para buscarla por texto', () => {
        expect(campos.color_80.options).toEqual(['Beige', 'Marrón', 'Negro']);
        expect(campos.tipo_product.options).toBeUndefined();
        expect(campos.tipo_product.listaLarga).toBe(true);
    });

    it('el texto libre no lleva lista ni se marca como larga', () => {
        expect(campos.modelo.options).toBeUndefined();
        expect(campos.modelo.listaLarga).toBeUndefined();
        expect(campos.modelo.type).toBe('text');
    });

    it('trae el nombre legible, si es obligatorio y si define la variante', () => {
        expect(campos.color_80.label).toBe('Color');
        expect(campos.color_80.required).toBe(true);
        expect(campos.color_80.isVariant).toBe(true);
        expect(campos.modelo.required).toBe(false);
    });

    it('sin atributos no falla', () => {
        expect(camposDeCategoria(undefined, listas)).toEqual([]);
    });
});

describe('ejesDeVariante', () => {
    it('devuelve los atributos que definen la variante', () => {
        expect(ejesDeVariante(atributos as any)).toEqual(['color_80']);
    });
    it('una categoría sin eje de variante no puede agrupar', () => {
        expect(ejesDeVariante([{ name: 'modelo', description: '', example: '', isRequired: false }])).toEqual([]);
        expect(ejesDeVariante(null)).toEqual([]);
    });
});

describe('validarAtributosEscritos', () => {
    it('lleva los valores de lista a la escritura exacta de Ripley', () => {
        const r = validarAtributosEscritos({ color_80: 'marron', escolar: 'si', modelo: 'PUFFER' }, atributos as any, listas);
        expect(r.atributos).toEqual({ color_80: 'Marrón', escolar: 'Sí', modelo: 'PUFFER' });
        expect(r.errores).toEqual([]);
    });

    it('rechaza un valor que no está en la lista, diciendo cuál campo', () => {
        const r = validarAtributosEscritos({ color_80: 'turquesa' }, atributos as any, listas);
        expect(r.errores).toEqual([{ campo: 'color_80', motivo: 'ese valor no está en la lista de Ripley' }]);
        expect(r.atributos.color_80).toBeUndefined();
    });

    it('rechaza un campo que la categoría no tiene', () => {
        const r = validarAtributosEscritos({ inventado: 'x' }, atributos as any, listas);
        expect(r.errores[0]).toEqual({ campo: 'inventado', motivo: 'esta categoría de Ripley no tiene ese campo' });
    });

    it('un campo vacío se ignora (borrar un valor es válido)', () => {
        const r = validarAtributosEscritos({ modelo: '   ', escolar: '' }, atributos as any, listas);
        expect(r.errores).toEqual([]);
        expect(r.atributos).toEqual({});
    });

    it('un tipo de producto de una lista larga también se valida', () => {
        const r = validarAtributosEscritos({ tipo_product: 'tipo 7' }, atributos as any, listas);
        expect(r.atributos.tipo_product).toBe('Tipo 7');
    });
});
