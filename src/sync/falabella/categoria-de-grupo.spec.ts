import { estadoDeCategoriaDeGrupo } from './categoria-de-grupo';

describe('categoría de Falabella de un grupo de variantes', () => {
    it('detecta las variantes sin categoría y recomienda la de las ya publicadas', () => {
        const r = estadoDeCategoriaDeGrupo([
            { id: 'a', categoria: '3223', publicada: true },
            { id: 'b', categoria: '3223', publicada: true },
            { id: 'c', categoria: '4', publicada: true },
            { id: 'd', categoria: null, publicada: false },
            { id: 'e', categoria: '', publicada: false },
        ]);
        expect(r.sinCategoria).toEqual(['d', 'e']);
        expect(r.recomendada).toBe('3223');
        expect(r.mezcladas).toBe(true);
        expect(r.categorias).toEqual([{ id: '3223', total: 2, publicadas: 2 }, { id: '4', total: 1, publicadas: 1 }]);
    });

    it('una categoría usada por las publicadas gana a una más repetida entre las que no se publicaron', () => {
        const r = estadoDeCategoriaDeGrupo([
            { id: 'a', categoria: '4', publicada: true },
            { id: 'b', categoria: '3223', publicada: false },
            { id: 'c', categoria: '3223', publicada: false },
        ]);
        expect(r.recomendada).toBe('4');
    });

    it('un grupo consistente no se marca como mezclado ni como incompleto', () => {
        const r = estadoDeCategoriaDeGrupo([{ id: 'a', categoria: '3223', publicada: true }, { id: 'b', categoria: '3223', publicada: false }]);
        expect(r.mezcladas).toBe(false);
        expect(r.sinCategoria).toEqual([]);
        expect(r.recomendada).toBe('3223');
    });

    it('sin ninguna categoría no hay recomendada', () => {
        const r = estadoDeCategoriaDeGrupo([{ id: 'a', categoria: null, publicada: false }]);
        expect(r.recomendada).toBeNull();
        expect(r.sinCategoria).toEqual(['a']);
    });
});

import { planDeUnificacion } from './categoria-de-grupo';

describe('plan para dejar una sola categoría por grupo', () => {
    it('da la categoría a las que faltan y alinea las no publicadas, sin tocar las ya publicadas', () => {
        const p = planDeUnificacion([
            { id: 'a', categoria: '3223', publicada: true },
            { id: 'b', categoria: '3223', publicada: true },
            { id: 'c', categoria: '4', publicada: true },
            { id: 'd', categoria: '4', publicada: false },
            { id: 'e', categoria: null, publicada: false },
        ]);
        expect(p).toEqual({ categoria: '3223', asignar: ['e'], igualar: ['d'], distintasPublicadas: ['c'] });
    });

    it('una categoría indicada manda sobre la más usada', () => {
        const p = planDeUnificacion([{ id: 'a', categoria: '3223', publicada: false }, { id: 'b', categoria: null, publicada: false }], '4');
        expect(p.categoria).toBe('4');
        expect(p.asignar).toEqual(['b']);
        expect(p.igualar).toEqual(['a']);
    });

    it('un grupo ya consistente no cambia nada', () => {
        const p = planDeUnificacion([{ id: 'a', categoria: '3223', publicada: true }, { id: 'b', categoria: '3223', publicada: false }]);
        expect(p).toEqual({ categoria: '3223', asignar: [], igualar: [], distintasPublicadas: [] });
    });

    it('sin ninguna categoría y sin indicar una, no hay plan', () => {
        expect(planDeUnificacion([{ id: 'a', categoria: null, publicada: false }]).categoria).toBeNull();
    });
});
