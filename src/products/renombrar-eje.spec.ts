import { renombrarClaveDeValores, renombrarEje } from './renombrar-eje';

const ejes = [{ name: 'Talla', values: ['2 plazas', 'King'] }, { name: 'Color', values: ['Blanco'] }];

describe('renombrarEje', () => {
    it('cambia solo el nombre del eje: los valores y el orden no se tocan', () => {
        expect(renombrarEje(ejes, 'Talla', 'Tamaño cama')).toEqual([{ name: 'Tamaño cama', values: ['2 plazas', 'King'] }, { name: 'Color', values: ['Blanco'] }]);
    });

    it('encuentra el eje sin importar mayúsculas ni espacios', () => {
        expect(renombrarEje(ejes, '  talla ', 'Tamaño cama')[0].name).toBe('Tamaño cama');
    });

    it('no deja renombrar a un nombre que ya usa otro eje', () => {
        expect(() => renombrarEje(ejes, 'Talla', 'color')).toThrow('Ya existe un eje');
    });

    it('avisa si el eje no existe', () => {
        expect(() => renombrarEje(ejes, 'Material', 'Tela')).toThrow('no tiene un eje');
    });

    it('el nombre nuevo no puede estar vacío', () => {
        expect(() => renombrarEje(ejes, 'Talla', '  ')).toThrow('Indica');
    });
});

describe('renombrarClaveDeValores', () => {
    it('renombra la clave del eje en una variante conservando el orden y los valores', () => {
        expect(renombrarClaveDeValores({ Talla: 'King', Color: 'Blanco' }, 'Talla', 'Tamaño cama')).toEqual({ 'Tamaño cama': 'King', Color: 'Blanco' });
        expect(Object.keys(renombrarClaveDeValores({ Talla: 'King', Color: 'Blanco' }, 'Talla', 'Tamaño cama')!)).toEqual(['Tamaño cama', 'Color']);
    });

    it('sin valores devuelve null', () => {
        expect(renombrarClaveDeValores(null, 'Talla', 'X')).toBeNull();
    });
});
