import { categoriasElegidas, fusionarCategorias } from './categorias-elegidas';

describe('categoriasElegidas', () => {
    it('devuelve la categoría ya guardada de cada canal', () => {
        expect(categoriasElegidas({ falabella_category_id: '3223', ripley_category_id: 'R141100000000', ripley_category_path: 'A › B' })).toEqual({ falabella: '3223', ripley: 'R141100000000' });
    });

    it('ignora las vacías y los datos que no son una categoría', () => {
        expect(categoriasElegidas({ falabella_category_id: '  ', mercadolibre_category_id: '', otra: 'x' })).toEqual({});
    });

    it('Mercado Libre también cuenta cuando la categoría quedó guardada en los atributos', () => {
        expect(categoriasElegidas({}, { mercadolibre_category_id: 'MPE123' })).toEqual({ mercadolibre: 'MPE123' });
        expect(categoriasElegidas({ mercadolibre_category_id: 'MPE1' }, { mercadolibre_category_id: 'MPE2' })).toEqual({ mercadolibre: 'MPE1' });
    });

    it('sin datos no falla', () => {
        expect(categoriasElegidas(null)).toEqual({});
        expect(categoriasElegidas(undefined, undefined)).toEqual({});
    });
});

describe('fusionarCategorias', () => {
    it('una categoría ya guardada no se reemplaza por la que propone la IA', () => {
        expect(fusionarCategorias({ falabella_category_id: '3223' }, { falabella_category_id: '999' })).toEqual({ falabella_category_id: '3223' });
    });

    it('la IA rellena las categorías que faltaban, sin tocar las demás', () => {
        expect(fusionarCategorias({ falabella_category_id: '3223' }, { falabella_category_id: '999', ripley_category_id: 'R1' })).toEqual({ falabella_category_id: '3223', ripley_category_id: 'R1' });
    });

    it('una categoría guardada pero vacía sí se completa', () => {
        expect(fusionarCategorias({ falabella_category_id: '' }, { falabella_category_id: '999' })).toEqual({ falabella_category_id: '999' });
    });

    it('conserva otros datos del producto', () => {
        expect(fusionarCategorias({ otro: 1 }, { ripley_category_id: 'R1' })).toEqual({ otro: 1, ripley_category_id: 'R1' });
    });

    it('sin nada nuevo deja lo que había', () => {
        expect(fusionarCategorias({ falabella_category_id: '3223' }, undefined)).toEqual({ falabella_category_id: '3223' });
        expect(fusionarCategorias(undefined, undefined)).toEqual({});
    });
});
