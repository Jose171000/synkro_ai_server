import { marcarComoIA, origenDeAtributo, origenesGenerales, quitarEstimado, quitarMarcaIA } from './origen-de-datos';

/**
 * La Ficha etiqueta lo que escribió la IA y lo que trajo el canal. «Canal» se calcula comparando con la copia importada
 * (si la persona lo cambia deja de serlo); «IA» se anota al escribirlo y se quita al editarlo.
 */
describe('anotar y quitar lo que escribió la IA', () => {
    it('marcar suma sin repetir y no modifica lo que recibe', () => {
        const original = { brand: 'X', _ia: ['aiTitle'] };
        const r = marcarComoIA(original, ['aiTitle', 'descriptionHtml']);
        expect(r._ia).toEqual(['aiTitle', 'descriptionHtml']);
        expect(original._ia).toEqual(['aiTitle']);
        expect(marcarComoIA(null, [])).toEqual({});
    });

    it('quitar saca solo los campos pedidos', () => {
        expect(quitarMarcaIA({ _ia: ['aiTitle', 'brand', 'descriptionHtml'] }, ['brand', 'aiTitle'])._ia).toEqual(['descriptionHtml']);
        expect(quitarMarcaIA({ brand: 'X' }, ['brand'])).toEqual({ brand: 'X' });
    });
});

describe('origen de los campos generales', () => {
    const importado = { falabella: { description: '<div>del canal</div>', brand: 'MUTANT', attributes: {} } };

    it('lo que sigue igual a lo importado es del canal; lo que la IA escribió, de la IA; lo demás no lleva etiqueta', () => {
        const o = origenesGenerales(
            { aiTitle: 'Título de la IA', aiDescription: 'Texto de una persona' },
            { descriptionHtml: '<div>del canal</div>', brand: 'mutant', _importado: importado, _ia: ['aiTitle', 'aiDescription'] },
        );
        expect(o).toEqual({ aiTitle: 'ia', aiDescription: 'ia', descriptionHtml: 'canal', brand: 'canal' });
    });

    it('si la persona cambia lo importado, deja de ser del canal; sin anotación de la IA no hay etiqueta', () => {
        const o = origenesGenerales({ aiTitle: 'Mío', aiDescription: null }, { descriptionHtml: '<div>cambiado a mano</div>', brand: 'OTRA', _importado: importado });
        expect(o).toEqual({});
    });

    it('un campo vacío nunca lleva etiqueta, aunque esté anotado', () => {
        expect(origenesGenerales({ aiTitle: '', aiDescription: null }, { _ia: ['aiTitle', 'brand', 'descriptionHtml'] })).toEqual({});
    });

    it('la descripción en texto que trajo Mercado Libre es del canal', () => {
        const o = origenesGenerales({ aiDescription: 'Texto de ML' }, { _importado: { mercadolibre: { description: 'Texto de ML' } } });
        expect(o.aiDescription).toBe('canal');
    });
});

describe('origen de un atributo', () => {
    const attrs = {
        _importado: { falabella: { attributes: { Sabor: 'Vainilla' } }, mercadolibre: { attributes: { BRAND: 'Mutant' } } },
        estimated: { measures: false, attributes: { falabella: ['Material'], mercadolibre: ['COLOR'] } },
    };

    it('Falabella: igual a lo importado es del canal (aunque se escriba distinto el nombre); estimado es de la IA', () => {
        expect(origenDeAtributo(attrs, 'falabella', 'sabor', 'vainilla')).toBe('canal');
        expect(origenDeAtributo(attrs, 'falabella', 'Material', 'Polvo')).toBe('ia');
    });

    it('un atributo importado que la persona cambió ya no es del canal', () => {
        expect(origenDeAtributo(attrs, 'falabella', 'Sabor', 'Chocolate')).toBeUndefined();
    });

    it('Mercado Libre: por id', () => {
        expect(origenDeAtributo(attrs, 'mercadolibre', 'BRAND', 'Mutant')).toBe('canal');
        expect(origenDeAtributo(attrs, 'mercadolibre', 'COLOR', 'Negro')).toBe('ia');
        expect(origenDeAtributo(attrs, 'mercadolibre', 'FLAVOR', 'Vainilla')).toBeUndefined();
    });

    it('sin valor no hay etiqueta', () => {
        expect(origenDeAtributo(attrs, 'falabella', 'Material', '  ')).toBeUndefined();
    });

    it('editar un atributo estimado lo saca de la lista, sin tocar los demás ni el original', () => {
        const r = quitarEstimado(attrs as any, 'falabella', ['material']);
        expect(r.estimated.attributes.falabella).toEqual([]);
        expect(r.estimated.attributes.mercadolibre).toEqual(['COLOR']);
        expect(attrs.estimated.attributes.falabella).toEqual(['Material']);
        expect(quitarEstimado({ brand: 'X' }, 'falabella', ['a'])).toEqual({ brand: 'X' });
    });
});
