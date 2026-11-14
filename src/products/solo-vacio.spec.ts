import { atributosLlenados, soloLoVacio } from './solo-vacio';

describe('soloLoVacio', () => {
    it('un producto vacío recibe todo y se dice qué se llenó', () => {
        const r = soloLoVacio(
            { aiTitle: null, aiDescription: '', aiKeywords: [], aiAttributes: {} },
            { aiTitle: 'Título IA', aiDescription: 'Desc IA', aiKeywords: ['a', 'b'], aiAttributes: { descriptionHtml: '<p>x</p>', brand: 'Casatex', color: 'Rojo', _ia: ['aiTitle', 'aiDescription', 'descriptionHtml'] } },
        );
        expect(r.final).toMatchObject({ aiTitle: 'Título IA', aiDescription: 'Desc IA', aiKeywords: ['a', 'b'] });
        expect(r.final.aiAttributes.descriptionHtml).toBe('<p>x</p>');
        expect(r.llenado).toEqual(['título', 'descripción', 'puntos clave', 'ficha HTML', '2 atributos']);
    });

    it('lo que ya tenía valor se queda y no se marca como hecho por la IA', () => {
        const r = soloLoVacio(
            { aiTitle: 'Mi título', aiDescription: 'Mi desc', aiKeywords: ['k'], aiAttributes: { descriptionHtml: '<p>mía</p>', brand: 'Marca', vision: { brand: 'X' }, _visionFotos: 'h1', _ia: ['aiTitle'] } },
            { aiTitle: 'Título IA', aiDescription: 'Desc IA', aiKeywords: ['a'], aiAttributes: { descriptionHtml: '<p>IA</p>', brand: 'Marca', color: 'Azul', vision: { brand: 'Y' }, _visionFotos: 'h2', _ia: ['aiTitle', 'aiDescription', 'descriptionHtml'] } },
        );
        expect(r.final).toMatchObject({ aiTitle: 'Mi título', aiDescription: 'Mi desc', aiKeywords: ['k'] });
        expect(r.final.aiAttributes.descriptionHtml).toBe('<p>mía</p>');
        expect(r.final.aiAttributes.vision).toEqual({ brand: 'X' });
        expect(r.final.aiAttributes._visionFotos).toBe('h1');
        expect(r.final.aiAttributes._ia).toEqual(['aiTitle']); // solo la marca que ya había
        expect(r.llenado).toEqual(['1 atributo']); // solo «color»
    });

    it('un producto ya completo no llena nada', () => {
        const completo = { aiTitle: 'T', aiDescription: 'D', aiKeywords: ['k'], aiAttributes: { descriptionHtml: '<p/>', brand: 'M' } };
        expect(soloLoVacio(completo, { ...completo, aiTitle: 'otro', aiAttributes: { ...completo.aiAttributes } }).llenado).toEqual([]);
    });
});

describe('atributosLlenados', () => {
    it('cuenta solo los vacíos que ahora tienen valor, también dentro de los grupos de canal', () => {
        const antes = { brand: 'M', color: '', mercadolibre_attributes: { MATERIAL: 'Algodón', COLOR: '' } };
        const despues = { brand: 'M', color: 'Rojo', model: 'X1', mercadolibre_attributes: { MATERIAL: 'Poliéster', COLOR: 'Rojo', LINE: 'Premium' }, _ia: ['x'], descriptionHtml: '<p/>' };
        expect(atributosLlenados(antes, despues)).toBe(4); // color, model, COLOR, LINE
    });
});
