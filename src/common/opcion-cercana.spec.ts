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

    it('un color de uso común que la lista escribe de otra forma («Vino» → «Burdeos»), con la preferencia de la lista', () => {
        expect(opcionCercana('Vino', ['Beige', 'Burdeo', 'Negro'])).toBe('Burdeo');
        expect(opcionCercana('Vino', ['Beige', 'Burdeos', 'Borgoña Caoba'])).toBe('Burdeos');
        expect(opcionCercana('vino tinto', ['Beige', 'Burdeos'])).toBe('Burdeos');
        expect(opcionCercana('Guinda', ['Rojo', 'Borgoña Caoba'])).toBe('Borgoña Caoba');
        expect(opcionCercana('Plomo', ['Blanco', 'Gris'])).toBe('Gris');
    });

    it('una opción exacta o parecida gana a la equivalencia, y si la lista no tiene ninguna equivalente no se inventa', () => {
        expect(opcionCercana('Rosado', ['Rosa', 'Rosado'])).toBe('Rosado');
        expect(opcionCercana('Vino', ['Beige', 'Negro', 'Fucsia'])).toBeUndefined();
    });

    it('nada parecido o sin opciones: undefined', () => {
        expect(opcionCercana('cerámica', materiales)).toBeUndefined();
        expect(opcionCercana('', materiales)).toBeUndefined();
        expect(opcionCercana('madera', [])).toBeUndefined();
    });
});
