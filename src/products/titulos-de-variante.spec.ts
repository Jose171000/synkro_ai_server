import { atributosConVariante, nombreDeFamilia, recortarEnPalabra, sinValoresAlFinal, tituloDeVariante } from './titulos-de-variante';

describe('títulos de variante', () => {
    const base = 'Perchero Elegante Multifuncional Kasari Metal Negro Azul';
    const colores = ['Negro', 'Celeste'];

    it('nunca parte una palabra: «Negr» ya no sale', () => {
        expect(recortarEnPalabra(base, 52)).toBe('Perchero Elegante Multifuncional Kasari Metal Negro');
        expect(recortarEnPalabra(base, 49)).toBe('Perchero Elegante Multifuncional Kasari Metal');
        expect(recortarEnPalabra('corto', 52)).toBe('corto');
    });

    it('quita del final los colores para no escribir «Negro - Negro»', () => {
        expect(tituloDeVariante(base, 'Negro', colores)).toBe('Perchero Elegante Multifuncional Kasari Metal - Negro');
        expect(tituloDeVariante(base, 'Celeste', colores)).toBe('Perchero Elegante Multifuncional Kasari Metal - Celeste');
    });

    it('respeta el máximo y lleva siempre la etiqueta de la variante', () => {
        const t = tituloDeVariante('Set 2 Pisos Cocina Antideslizantes Azul Utensilios 120x40', 'Celeste', ['Celeste', 'Negro'])!;
        expect(t.length).toBeLessThanOrEqual(60);
        expect(t.endsWith(' - Celeste')).toBe(true);
        expect(t).not.toMatch(/\s\S{1,3} - Celeste$/); // sin palabra truncada pegada
    });

    it('un título sin base no inventa nada', () => {
        expect(tituloDeVariante(undefined, 'Rojo')).toBeUndefined();
    });

    it('el nombre de la familia no lleva colores y es el mismo para todas las variantes', () => {
        expect(nombreDeFamilia(base, colores)).toBe('Perchero Elegante Multifuncional Kasari Metal');
        expect(nombreDeFamilia('Picatodo Manual Kasari Recipiente Transparente Rosado', ['Rosa', 'Verde'])).toBe('Picatodo Manual Kasari Recipiente');
        expect(nombreDeFamilia('Perchero', colores)).toBe('Perchero');
    });

    it('un valor de eje que no es color también se quita del final', () => {
        expect(sinValoresAlFinal('Polo Algodón Estampado Stitch', ['Stitch', 'Mickey'])).toBe('Polo Algodón Estampado');
    });
});

describe('atributos de una variante', () => {
    it('el color de la variante gana al del producto base, y también el color básico', () => {
        const molde = { color: 'Azul', color_basico: 'Negro', brand: 'Kasari', Color: 'Azul' };
        expect(atributosConVariante(molde, { Color: 'Celeste' })).toMatchObject({ color: 'Celeste', color_basico: 'Celeste', Color: 'Celeste', brand: 'Kasari' });
    });

    it('no inventa atributos que el producto no tenía', () => {
        expect(atributosConVariante({ brand: 'X' }, { Color: 'Rojo' })).toEqual({ brand: 'X' });
    });

    it('sin valores de variante deja todo igual', () => {
        expect(atributosConVariante({ color: 'Azul' }, null)).toEqual({ color: 'Azul' });
    });
});
