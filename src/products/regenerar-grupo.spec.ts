import { atributosTrasRegenerar, esAtributoDeEje, sinAtributosDeEje } from './regenerar-grupo';
import { fotosParaIA } from './fotos-para-ia';
import { textoDeEjes } from '../ai/ejes-de-variacion';

describe('regenerar el contenido de un grupo con IA', () => {
    const ejes = [{ name: 'Color' }, { name: 'Talla' }];

    it('el color y la talla (y los ejes del grupo) son propios de cada variante', () => {
        expect(esAtributoDeEje('Color', ejes)).toBe(true);
        expect(esAtributoDeEje('ColorBasico', ejes)).toBe(true);
        expect(esAtributoDeEje('Talla', ejes)).toBe(true);
        expect(esAtributoDeEje('Material', ejes)).toBe(false);
        expect(esAtributoDeEje('Acabado', [{ name: 'Acabado' }])).toBe(true);
        expect(sinAtributosDeEje({ Color: 'Rojo', material: 'Cuero', talla: '36' }, ejes)).toEqual({ material: 'Cuero' });
    });

    it('lo que la variante ya tenía se conserva y la IA solo rellena lo vacío; la ficha HTML se rehace', () => {
        const r = atributosTrasRegenerar(
            { brand: 'JOLI JOLI', Color: 'Beige', Talla: '35', descriptionHtml: '<p>viejo</p>', material: '' },
            { material: 'Cuero', brand: 'OTRA', descriptionHtml: 'x' },
            { htmlDescription: '<p>nuevo</p>' },
            [],
        );
        expect(r.brand).toBe('JOLI JOLI');
        expect(r.Color).toBe('Beige');
        expect(r.Talla).toBe('35');
        expect(r.material).toBe('Cuero');
        expect(r.descriptionHtml).toBe('<p>nuevo</p>');
    });

    it('lo que la IA reescribe queda marcado como de la IA y lo que una persona editó antes se mantiene', () => {
        const r = atributosTrasRegenerar({ brand: 'X', _ia: ['aiTitle', 'descriptionHtml', 'material'] }, { _ia: ['aiTitle', 'aiDescription', 'descriptionHtml'] }, { htmlDescription: '<p>n</p>' }, []);
        expect(r._ia.sort()).toEqual(['aiDescription', 'aiTitle', 'descriptionHtml', 'material'].sort());
    });

    it('guarda lo que se vio en las fotos y la huella de las fotos analizadas', () => {
        const r = atributosTrasRegenerar({}, {}, { vision: { productType: 'sandalia' } }, ['https://i/1.jpg']);
        expect(r.vision).toEqual({ productType: 'sandalia' });
        expect(typeof r._visionFotos).toBe('string');
    });
});

describe('fotos que mira la IA de un producto con variantes', () => {
    const v = (...urls: string[]) => ({ images: urls.map((url) => ({ url })) });

    it('una de cada variante, sin repetir, hasta el límite', () => {
        const variantes = [v('a1', 'a2'), v('a1', 'a2'), v('b1'), v('c1'), v('d1'), v('e1')];
        expect(fotosParaIA(variantes, 4)).toEqual(['a1', 'b1', 'c1', 'd1']);
    });

    it('si sobra lugar se completa con las demás fotos', () => {
        expect(fotosParaIA([v('a1', 'a2', 'a3'), v('b1')], 4)).toEqual(['a1', 'b1', 'a2', 'a3']);
    });

    it('variantes sin fotos no rompen', () => {
        expect(fotosParaIA([{ images: null }, {}, v('a1')], 4)).toEqual(['a1']);
    });
});

describe('ejes que se le pasan a la IA', () => {
    it('lista cada eje con sus valores y aclara que es una sola publicación', () => {
        const t = textoDeEjes([{ name: 'Color', values: ['Beige', 'Vino', 'Beige'] }, { name: 'Talla', values: ['35', '36'] }]);
        expect(t).toContain('UNA sola publicación');
        expect(t).toContain('- Color: Beige, Vino');
        expect(t).toContain('- Talla: 35, 36');
    });

    it('un producto sin ejes no agrega nada', () => {
        expect(textoDeEjes([])).toBe('');
        expect(textoDeEjes(null)).toBe('');
        expect(textoDeEjes([{ name: 'Color', values: [] }])).toBe('');
    });
});
