import { contarPasadas, debeAvisar, diferenciasDe, EnlaceParaConciliar, firmaDe, resumenDeAviso } from './conciliacion';

const enlace = (over: Partial<EnlaceParaConciliar> = {}): EnlaceParaConciliar => ({
    linkId: 'l1', productId: 'p1', sku: '23011009', nombre: 'Audífonos', marketplace: 'ripley', connectionId: 'c1', cuenta: 'NodoShop',
    stockSynkro: 0, stockCanal: 14, precioSynkro: 65, precioCanal: 65, rebajaCanal: null, precioPropio: null, ...over,
});
const nombre = (id: string) => ({ ripley: 'Ripley', falabella: 'Falabella' } as Record<string, string>)[id] ?? id;

describe('conciliación: qué es una diferencia', () => {
    it('el stock distinto es una diferencia en cualquier canal; igual o sin dato del canal, no', () => {
        expect(diferenciasDe(enlace(), { precioRipley: false })).toHaveLength(1);
        expect(diferenciasDe(enlace({ marketplace: 'falabella' }), { precioRipley: false })).toHaveLength(1);
        expect(diferenciasDe(enlace({ stockCanal: 0 }), { precioRipley: false })).toEqual([]);
        expect(diferenciasDe(enlace({ stockCanal: null }), { precioRipley: false })).toEqual([]);
        expect(diferenciasDe(enlace({ stockSynkro: null }), { precioRipley: false })).toEqual([]);
    });

    it('el precio solo se compara en Ripley, sin rebaja, sin precio propio y con el envío de precios habilitado', () => {
        const distinto = enlace({ stockCanal: 0, precioCanal: 35, precioSynkro: 60 });
        expect(diferenciasDe(distinto, { precioRipley: true })).toMatchObject([{ campo: 'price', canal: 35, synkro: 60 }]);
        expect(diferenciasDe(distinto, { precioRipley: false })).toEqual([]);
        expect(diferenciasDe({ ...distinto, rebajaCanal: 25 }, { precioRipley: true })).toEqual([]);
        expect(diferenciasDe({ ...distinto, precioPropio: 50 }, { precioRipley: true })).toEqual([]);
        expect(diferenciasDe({ ...distinto, marketplace: 'falabella' }, { precioRipley: true })).toEqual([]);
        expect(diferenciasDe({ ...distinto, precioCanal: 60.001 }, { precioRipley: true })).toEqual([]);
    });
});

describe('conciliación: persistencia y aviso', () => {
    const [d] = diferenciasDe(enlace(), { precioRipley: false });

    it('una diferencia solo es persistente a la segunda revisión seguida; si el valor cambia, empieza de nuevo; si desaparece, se olvida', () => {
        const primera = contarPasadas(undefined, [d]);
        expect(primera.persistentes).toEqual([]);
        const segunda = contarPasadas(primera.estado, [d]);
        expect(segunda.persistentes).toEqual([d]);
        const [otro] = diferenciasDe(enlace({ stockCanal: 9 }), { precioRipley: false });
        expect(contarPasadas(segunda.estado, [otro]).persistentes).toEqual([]);
        expect(contarPasadas(segunda.estado, [])).toEqual({ estado: {}, persistentes: [] });
    });

    it('avisa cuando la lista cambia o pasaron 24 h; no repite el mismo aviso antes', () => {
        const firma = firmaDe([d]);
        const t0 = 1_000_000_000_000;
        expect(debeAvisar({ firma, firmaAvisada: null, avisadoEn: null, ahora: t0 })).toBe(true);
        expect(debeAvisar({ firma, firmaAvisada: firma, avisadoEn: t0, ahora: t0 + 3600_000 })).toBe(false);
        expect(debeAvisar({ firma, firmaAvisada: firma, avisadoEn: t0, ahora: t0 + 25 * 3600_000 })).toBe(true);
        expect(debeAvisar({ firma: 'otra', firmaAvisada: firma, avisadoEn: t0, ahora: t0 + 1000 })).toBe(true);
        expect(debeAvisar({ firma: '', firmaAvisada: firma, avisadoEn: t0, ahora: t0 + 99 * 3600_000 })).toBe(false);
        expect(firmaDe([])).toBe('');
        expect(firmaDe([d])).toBe(firmaDe([{ ...d }]));
    });
});

describe('conciliación: el aviso', () => {
    it('es de advertencia si el canal tiene más stock del que hay; lista lo más grave primero y dice cuántas más hay', () => {
        const muchas = Array.from({ length: 7 }, (_, i) =>
            diferenciasDe(enlace({ linkId: `l${i}`, sku: `S${i}`, stockCanal: i === 6 ? 0 : 14, stockSynkro: i === 6 ? 3 : 0 }), { precioRipley: false })[0]);
        const r = resumenDeAviso(muchas, nombre);
        expect(r.severity).toBe('warning');
        expect(r.title).toBe('Diferencias con Synkro: 7 con stock distinto');
        expect(r.body).toContain('S0 (Ripley · NodoShop): stock 14 en el canal, 0 en Synkro');
        expect(r.body).not.toContain('S6'); // el menos grave queda fuera de las 5 líneas
        expect(r.body).toContain('y 2 más');
        expect(r.items).toHaveLength(7);
    });

    it('es informativo si el canal tiene menos stock que Synkro; el título cuenta stock y precio', () => {
        const menos = diferenciasDe(enlace({ stockCanal: 1, stockSynkro: 5, precioCanal: 70, precioSynkro: 60 }), { precioRipley: true });
        const r = resumenDeAviso(menos, nombre);
        expect(r.severity).toBe('info');
        expect(r.title).toBe('Diferencias con Synkro: 1 con stock distinto y 1 con precio distinto');
        const conRiesgoDePrecio = resumenDeAviso(diferenciasDe(enlace({ stockCanal: 0, precioCanal: 35, precioSynkro: 60 }), { precioRipley: true }), nombre);
        expect(conRiesgoDePrecio.severity).toBe('warning'); // el canal vende más barato que Synkro
    });
});
