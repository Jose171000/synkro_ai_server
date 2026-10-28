import { conUnidadMeli, medidasQueFaltan } from './unidades-meli';

describe('unidades de las medidas de Mercado Libre', () => {
    it('un número suelto en alto, ancho, largo o profundidad se envía en cm', () => {
        expect(conUnidadMeli('HEIGHT', '35')).toBe('35 cm');
        expect(conUnidadMeli('DEPTH', '40,5')).toBe('40,5 cm');
        expect(conUnidadMeli('SEAT_HEIGHT', ' 45 ')).toBe('45 cm');
    });

    it('no toca lo que ya trae unidad ni los atributos que no son medidas', () => {
        expect(conUnidadMeli('HEIGHT', '35 cm')).toBe('35 cm');
        expect(conUnidadMeli('WIDTH', '1.2 m')).toBe('1.2 m');
        expect(conUnidadMeli('COLOR', '35')).toBe('35');
        expect(conUnidadMeli('NUMBER_OF_SHELVES', '4')).toBe('4');
    });

    it('completa solo las medidas obligatorias vacías con las del paquete', () => {
        const requisitos = [
            { name: 'DEPTH', isRequired: true },
            { name: 'HEIGHT', isRequired: true },
            { name: 'WIDTH', isRequired: false },
            { name: 'COLOR', isRequired: true },
        ];
        const r = medidasQueFaltan({ HEIGHT: '120 cm' }, requisitos, { width: 30, length: 41.26, height: 20 });
        expect(r).toEqual({ DEPTH: '41.3 cm' });
    });

    it('sin medidas del paquete no inventa nada', () => {
        expect(medidasQueFaltan({}, [{ name: 'DEPTH', isRequired: true }], null)).toEqual({});
    });
});
