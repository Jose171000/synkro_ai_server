import { concurrenciaDeLaCola } from './concurrencia-cola';

describe('concurrencia de la cola de IA', () => {
    it('sin variable o con un valor que no sirve se queda en 1, como siempre', () => {
        for (const v of [undefined, '', '  ', 'abc', '0', '-3', '2.5', '6 productos', 'NaN']) {
            expect(concurrenciaDeLaCola(v)).toBe(1);
        }
    });

    it('toma el número que se le da, con espacios incluidos', () => {
        expect(concurrenciaDeLaCola('2')).toBe(2);
        expect(concurrenciaDeLaCola(' 6 ')).toBe(6);
    });

    it('tiene un tope para que un error de tipeo no lance cientos de llamadas a la vez', () => {
        expect(concurrenciaDeLaCola('20')).toBe(20);
        expect(concurrenciaDeLaCola('600')).toBe(20);
    });
});
