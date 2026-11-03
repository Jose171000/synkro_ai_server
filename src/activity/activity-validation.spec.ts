import { limpiarEtiqueta, validarLote } from './activity-validation';

const SESION = '7d6f1c9e-3b1a-4f0e-9d2a-5c8e0a1b2c3d';
const AHORA = new Date('2026-11-03T15:00:00Z');

describe('etiquetas de pantallas y elementos', () => {
    it('quedan en minúsculas, sin tildes ni signos raros', () => {
        expect(limpiarEtiqueta('Registrar ventas')).toBe('registrar-ventas');
        expect(limpiarEtiqueta('Ventas.Descargar')).toBe('ventas.descargar');
        expect(limpiarEtiqueta('  Envío gratis!  ')).toBe('envio-gratis');
    });

    it('se rechaza lo que parece un dato personal o un identificador', () => {
        expect(limpiarEtiqueta('juan@correo.com')).toBeNull();
        expect(limpiarEtiqueta('Pedido 3259674549')).toBeNull();
        expect(limpiarEtiqueta('999888777')).toBeNull();
        expect(limpiarEtiqueta('7d6f1c9e-3b1a-4f0e-9d2a-5c8e0a1b2c3d')).toBeNull();
        expect(limpiarEtiqueta('')).toBeNull();
        expect(limpiarEtiqueta(42)).toBeNull();
    });

    it('un número corto sí pasa (por ejemplo «30 días»)', () => {
        expect(limpiarEtiqueta('30 días')).toBe('30-dias');
    });

    it('se corta al largo máximo', () => {
        expect(limpiarEtiqueta('a'.repeat(200), 60)).toHaveLength(60);
    });
});

describe('validación del lote de eventos', () => {
    it('sin una sesión válida no se acepta nada', () => {
        expect(validarLote(null)).toBeNull();
        expect(validarLote({ sessionId: 'abc', events: [] })).toBeNull();
    });

    it('acepta vistas, clics y pings y descarta lo que no sirve', () => {
        const r = validarLote({
            sessionId: SESION,
            events: [
                { t: 'view', screen: 'Ventas' },
                { t: 'click', screen: 'ventas', element: 'Descargar', x: 420.4, y: 99, ex: 400, ey: 90, ew: 90, eh: 30 },
                { t: 'ping', screen: 'ventas', v: 30 },
                { t: 'raro', screen: 'ventas' },
                { t: 'view', screen: 'juan@correo.com' },
                { t: 'ping', screen: 'ventas', v: 9999 },
            ],
        }, AHORA)!;
        expect(r.eventos.map(e => e.type)).toEqual(['view', 'click', 'ping']);
        expect(r.descartados).toBe(3);
        expect(r.eventos[1]).toMatchObject({ screen: 'ventas', element: 'descargar', x: 420, y: 99, ex: 400, eh: 30 });
        expect(r.eventos[2]).toMatchObject({ value: 30, element: null });
    });

    it('un clic sin nombre aprovechable queda como «otros»; las coordenadas fuera de rango se ignoran', () => {
        const r = validarLote({ sessionId: SESION, events: [{ t: 'click', screen: 'ventas', element: 'Cliente 3259674549', x: 5000, y: -3 }] }, AHORA)!;
        expect(r.eventos[0]).toMatchObject({ element: 'otros', x: null, y: null });
    });

    it('la hora del evento se acepta si es reciente; si no, se usa la del servidor', () => {
        const reciente = AHORA.getTime() - 60_000;
        const r = validarLote({ sessionId: SESION, events: [{ t: 'view', screen: 'a', at: reciente }, { t: 'view', screen: 'b', at: 12345 }, { t: 'view', screen: 'c', at: AHORA.getTime() + 3_600_000 }] }, AHORA)!;
        expect(r.eventos[0].at.getTime()).toBe(reciente);
        expect(r.eventos[1].at).toEqual(AHORA);
        expect(r.eventos[2].at).toEqual(AHORA);
    });

    it('tiene un tope de eventos por lote y cuenta el exceso como descartado', () => {
        const events = Array.from({ length: 130 }, () => ({ t: 'view', screen: 'ventas' }));
        const r = validarLote({ sessionId: SESION, events }, AHORA)!;
        expect(r.eventos).toHaveLength(100);
        expect(r.descartados).toBe(30);
    });

    it('la tienda y el dispositivo se validan', () => {
        const r = validarLote({ sessionId: SESION, storeId: 'no-es-uuid', device: 'tostadora', events: [] }, AHORA)!;
        expect(r).toMatchObject({ storeId: null, device: 'escritorio' });
        const s = validarLote({ sessionId: SESION, storeId: SESION, device: 'movil', events: [] }, AHORA)!;
        expect(s).toMatchObject({ storeId: SESION, device: 'movil' });
    });
});
