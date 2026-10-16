import { opcionCercana } from './opcion-cercana';

describe('ajustar un valor a la lista de opciones del canal', () => {
    const materiales = ['Algodón', 'Madera', 'Plástico', 'Madera MDF', 'Acero inoxidable', 'Tela de poliéster'];

    it('la opción exacta, sin importar mayúsculas ni tildes', () => {
        expect(opcionCercana('ALGODON', materiales)).toBe('Algodón');
        expect(opcionCercana('plástico', materiales)).toBe('Plástico');
    });

    it('una frase que contiene la opción, o la opción que contiene la frase', () => {
        expect(opcionCercana('madera de pino', materiales)).toBe('Madera');
        expect(opcionCercana('inoxidable', materiales)).toBe('Acero inoxidable');
    });

    it('palabras en común cuando no hay inclusión', () => {
        expect(opcionCercana('poliéster tejido', materiales)).toBe('Tela de poliéster');
    });

    it('nada parecido o sin opciones: undefined', () => {
        expect(opcionCercana('cerámica', materiales)).toBeUndefined();
        expect(opcionCercana('', materiales)).toBeUndefined();
        expect(opcionCercana('madera', [])).toBeUndefined();
    });
});
