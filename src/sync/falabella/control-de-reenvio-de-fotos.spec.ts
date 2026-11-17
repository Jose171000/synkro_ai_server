import {
    ESPERA_ENTRE_REENVIOS_MS, MAX_REENVIOS_POR_PRODUCTO, PAUSA_ENTRE_PETICIONES_MS,
    anotarReenvio, decidirReenvio, segundosParaOtraPeticion,
} from './control-de-reenvio-de-fotos';

describe('control de reenvío de fotos a Falabella', () => {
    const ahora = Date.parse('2026-11-16T12:00:00Z');

    it('un producto que nunca se reenvió puede reenviarse', () => {
        expect(decidirReenvio(undefined, ahora)).toEqual({ permitido: true });
        expect(decidirReenvio({}, ahora)).toEqual({ permitido: true });
    });

    it('no se reenvía de nuevo antes de que pase la espera', () => {
        const hace10 = new Date(ahora - 10 * 60_000).toISOString();
        const r = decidirReenvio({ ultima: hace10, veces: 1 }, ahora);
        expect(r.permitido).toBe(false);
        expect(r.permitido === false && r.motivo).toContain('espera 20 min');
    });

    it('pasada la espera vuelve a poder reenviarse', () => {
        const antes = new Date(ahora - ESPERA_ENTRE_REENVIOS_MS - 1000).toISOString();
        expect(decidirReenvio({ ultima: antes, veces: 2 }, ahora)).toEqual({ permitido: true });
    });

    it('tras el máximo de reenvíos ya no se reenvía más y explica qué revisar', () => {
        const hace1dia = new Date(ahora - 86_400_000).toISOString();
        const r = decidirReenvio({ ultima: hace1dia, veces: MAX_REENVIOS_POR_PRODUCTO }, ahora);
        expect(r.permitido).toBe(false);
        expect(r.permitido === false && r.motivo).toContain('soporte de Falabella');
    });

    it('anotar un reenvío suma uno y guarda la hora', () => {
        expect(anotarReenvio({ veces: 2 }, ahora)).toEqual({ ultima: '2026-11-16T12:00:00.000Z', veces: 3 });
        expect(anotarReenvio(undefined, ahora).veces).toBe(1);
    });

    it('entre dos peticiones a la misma cuenta hay una pausa', () => {
        expect(segundosParaOtraPeticion(undefined, ahora)).toBe(0);
        expect(segundosParaOtraPeticion(ahora - 30_000, ahora)).toBe(90);
        expect(segundosParaOtraPeticion(ahora - PAUSA_ENTRE_PETICIONES_MS - 1, ahora)).toBe(0);
    });
});

describe('reenvío automático de fotos (nadie tiene que ocuparse)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { decidirAutoReenvio, MAX_REENVIOS_POR_PRODUCTO, ESPERA_ENTRE_REENVIOS_MS } = require('./control-de-reenvio-de-fotos');
    const ahora = Date.parse('2026-11-17T12:00:00Z');

    it('la primera vez reenvía sin esperar', () => {
        expect(decidirAutoReenvio(undefined, ahora)).toEqual({ accion: 'reenviar' });
    });

    it('si se reenvió hace poco espera los minutos que faltan, sin rendirse', () => {
        const registro = { ultima: new Date(ahora - 10 * 60_000).toISOString(), veces: 1 };
        expect(decidirAutoReenvio(registro, ahora)).toEqual({ accion: 'esperar', minutos: 20 });
    });

    it('pasada la espera vuelve a reenviar', () => {
        const registro = { ultima: new Date(ahora - ESPERA_ENTRE_REENVIOS_MS - 1000).toISOString(), veces: 2 };
        expect(decidirAutoReenvio(registro, ahora)).toEqual({ accion: 'reenviar' });
    });

    it('con todos los intentos gastados se rinde y dice por qué', () => {
        const r = decidirAutoReenvio({ ultima: new Date(ahora - ESPERA_ENTRE_REENVIOS_MS * 2).toISOString(), veces: MAX_REENVIOS_POR_PRODUCTO }, ahora);
        expect(r.accion).toBe('rendirse');
        expect((r as any).motivo).toMatch(/sin resultado/);
    });
});
