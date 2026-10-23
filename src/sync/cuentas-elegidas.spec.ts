import { cuentasParaPublicar, leerCuentasElegidas } from './cuentas-elegidas';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

describe('cuentas elegidas para publicar', () => {
    it('sin elección se usan todas las cuentas activas del canal (como antes)', () => {
        expect(cuentasParaPublicar([A, B])).toEqual([A, B]);
        expect(cuentasParaPublicar([A, B], [])).toEqual([A, B]);
    });

    it('con elección solo se usan las elegidas que siguen activas', () => {
        expect(cuentasParaPublicar([A, B], [B])).toEqual([B]);
        expect(cuentasParaPublicar([A], [B])).toEqual([]); // la cuenta elegida ya no está activa: no se publica en otra
    });

    it('lee la elección de un JSON o de un objeto, y descarta lo que no tiene la forma esperada', () => {
        expect(leerCuentasElegidas(JSON.stringify({ MercadoLibre: [A, B], falabella: A }))).toEqual({ mercadolibre: [A, B], falabella: [A] });
        expect(leerCuentasElegidas({ mercadolibre: [A, A, 'no-es-id', 5] })).toEqual({ mercadolibre: [A] });
        expect(leerCuentasElegidas('{roto')).toEqual({});
        expect(leerCuentasElegidas(['a'])).toEqual({});
        expect(leerCuentasElegidas(null)).toEqual({});
    });
});
