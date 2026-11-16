import { fusionarAtributos } from './fusionar-atributos';

describe('fusionarAtributos', () => {
    it('el valor nuevo reemplaza a todas las escrituras equivalentes del mismo atributo', () => {
        const r = fusionarAtributos({ Gramaje: '650 g', gramaje_: '500 g', brand: 'LAI HOME' }, { gramaje: '700 g' });
        expect(r).toEqual({ brand: 'LAI HOME', gramaje: '700 g' });
    });

    it('conserva lo que no se edita', () => {
        expect(fusionarAtributos({ a: '1', vision: { x: 1 } }, { b: '2' })).toEqual({ a: '1', vision: { x: 1 }, b: '2' });
    });

    it('tolera entradas vacías', () => {
        expect(fusionarAtributos(null, { a: '1' })).toEqual({ a: '1' });
        expect(fusionarAtributos({ a: '1' }, undefined)).toEqual({ a: '1' });
    });
});
