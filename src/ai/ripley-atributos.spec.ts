import { ajustarAtributosDeRipley, ajustarAUnaLista, candidatosDeLista, conOpcionesParaLaIa, MAX_LISTA_EN_PROMPT } from './ripley-atributos';

const COLORES = ['Beige', 'Marrón', 'Marrón Claro', 'Café', 'Café Oscuro', 'Negro', 'Rosado', 'Azul', 'Azul Marino', 'Multicolor'];

describe('ajustarAUnaLista', () => {
    it('acepta el valor tal cual, sin importar mayúsculas ni tildes', () => {
        expect(ajustarAUnaLista('marron', COLORES)).toBe('Marrón');
        expect(ajustarAUnaLista('NEGRO', COLORES)).toBe('Negro');
        expect(ajustarAUnaLista('  cafe  ', COLORES)).toBe('Café');
    });

    it('entiende singular y plural', () => {
        expect(ajustarAUnaLista('lonchera', ['Loncheras', 'Maletas'])).toBe('Loncheras');
        expect(ajustarAUnaLista('Maleta', ['Loncheras', 'Maletas'])).toBe('Maletas');
    });

    it('«Marrón oscuro» se lleva a «Marrón», no a otro color', () => {
        expect(ajustarAUnaLista('marrón oscuro', COLORES)).toBe('Marrón');
    });

    it('usa el valor más largo que aparece completo («Azul Marino» antes que «Azul»)', () => {
        expect(ajustarAUnaLista('azul marino intenso', COLORES)).toBe('Azul Marino');
    });

    it('no adivina cuando hay varias opciones que lo contienen', () => {
        expect(ajustarAUnaLista('cafe', ['Café Claro', 'Café Oscuro'])).toBeNull();
    });

    it('un valor sin equivalente da null (queda como dato faltante)', () => {
        expect(ajustarAUnaLista('turquesa', COLORES)).toBeNull();
        expect(ajustarAUnaLista('', COLORES)).toBeNull();
        expect(ajustarAUnaLista('Negro', [])).toBeNull();
    });

    it('listas de Sí / No: acepta sí, si, yes, true, no, false', () => {
        const sn = ['Sí', 'No'];
        expect(ajustarAUnaLista('sí', sn)).toBe('Sí');
        expect(ajustarAUnaLista('Si', sn)).toBe('Sí');
        expect(ajustarAUnaLista('true', sn)).toBe('Sí');
        expect(ajustarAUnaLista('NO', sn)).toBe('No');
        expect(ajustarAUnaLista('false', sn)).toBe('No');
        expect(ajustarAUnaLista('quizás', sn)).toBeNull();
    });
});

describe('candidatosDeLista', () => {
    const TIPOS = ['Abrigos', 'Loncheras', 'Lonchera Térmica', 'Mochilas', 'Maletas', 'Cartera Mujer', 'Botellas Térmicas', 'Zapatos'];

    it('devuelve los tipos que comparten palabras con el producto, los más parecidos primero', () => {
        const c = candidatosDeLista(TIPOS, ['LONCHERA MARRÓN TÉRMICA PARA ALIMENTOS TIPO PUFFER', 'lonchera']);
        expect(c[0]).toBe('Lonchera Térmica');
        expect(c).toContain('Loncheras');
        expect(c).not.toContain('Abrigos');
    });

    it('sin palabras útiles no inventa candidatos', () => {
        expect(candidatosDeLista(TIPOS, ['', null, undefined])).toEqual([]);
    });

    it('respeta el máximo', () => {
        expect(candidatosDeLista(TIPOS, ['mochila maleta lonchera cartera zapatos'], 2)).toHaveLength(2);
    });
});

describe('conOpcionesParaLaIa', () => {
    const corta = ['Sí', 'No'];
    const larga = Array.from({ length: MAX_LISTA_EN_PROMPT + 50 }, (_, i) => (i === 7 ? 'Loncheras' : `Tipo ${i}`));
    const listas = new Map([['escolar', corta], ['tipo_product', larga]]);
    const atributos = [
        { name: 'escolar', description: 'Escolar', example: '', isRequired: true, listCode: 'escolar' },
        { name: 'tipo_product', description: 'Tipo', example: '', isRequired: true, listCode: 'tipo_product' },
        { name: 'modelo', description: 'Modelo', example: '', isRequired: false },
    ];

    it('lista corta completa, lista larga solo con candidatos, texto libre sin tocar', () => {
        const r = Object.fromEntries(conOpcionesParaLaIa(atributos, listas, ['lonchera térmica']).map((a) => [a.name, a]));
        expect(r.escolar.options).toEqual(['Sí', 'No']);
        expect(r.tipo_product.options).toEqual(['Loncheras']);
        expect(r.modelo.options).toBeUndefined();
    });
});

describe('ajustarAtributosDeRipley', () => {
    const listas = new Map([['color_80', COLORES], ['escolar', ['Sí', 'No']]]);
    const requisitos = [
        { name: 'color_80', description: '', example: '', isRequired: true, listCode: 'color_80' },
        { name: 'escolar', description: '', example: '', isRequired: true, listCode: 'escolar' },
        { name: 'modelo', description: '', example: '', isRequired: false },
    ];

    it('lleva cada valor a la lista, informa lo cambiado y deja el texto libre como está', () => {
        const r = ajustarAtributosDeRipley({ color_80: 'marron oscuro', escolar: 'no', modelo: 'LONCHERA PUFFER' }, requisitos, listas);
        expect(r.atributos).toEqual({ color_80: 'Marrón', escolar: 'No', modelo: 'LONCHERA PUFFER' });
        expect(r.ajustados.color_80).toEqual({ de: 'marron oscuro', a: 'Marrón' });
        expect(r.invalidos).toEqual([]);
    });

    it('un valor sin equivalente se quita y se informa (queda como dato faltante)', () => {
        const r = ajustarAtributosDeRipley({ color_80: 'turquesa', escolar: 'Sí' }, requisitos, listas);
        expect(r.atributos.color_80).toBeUndefined();
        expect(r.invalidos).toEqual(['color_80']);
        expect(r.atributos.escolar).toBe('Sí');
    });

    it('un atributo vacío o ausente no se toca ni se marca como inválido', () => {
        const r = ajustarAtributosDeRipley({ color_80: null }, requisitos, listas);
        expect(r.invalidos).toEqual([]);
    });

    it('sin atributos no falla', () => {
        expect(ajustarAtributosDeRipley(undefined, requisitos, listas).atributos).toEqual({});
    });
});
