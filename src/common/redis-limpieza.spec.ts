process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test';
import { leerClaveDeTrabajo, limpiarTrabajosSueltos } from './redis-limpieza';

/** Un Redis mínimo en memoria con lo que usa la limpieza. */
function redisFalso(opts: { claves: Record<string, Record<string, string>>; zsets?: Record<string, string[]>; listas?: Record<string, string[]> }) {
    const claves = { ...opts.claves };
    const unlink = jest.fn(async (...ks: string[]) => { ks.forEach((k) => delete claves[k]); return ks.length; });
    return {
        claves,
        unlink,
        scan: jest.fn(async () => ['0', Object.keys(claves)]),
        zrange: jest.fn(async (k: string) => opts.zsets?.[k] ?? []),
        lrange: jest.fn(async (k: string) => opts.listas?.[k] ?? []),
        call: jest.fn(async () => 1000),
        pipeline: (cmds: any[]) => ({ exec: async () => cmds.map(([, k, campo]) => [null, claves[k]?.[campo] ?? null]) }),
    } as any;
}

const antiguo = String(Date.now() - 5 * 3600_000);
const reciente = String(Date.now() - 60_000);

describe('limpieza de trabajos sueltos de Redis', () => {
    it('reconoce la clave de un trabajo y sus auxiliares', () => {
        expect(leerClaveDeTrabajo('bull:q:12', 'q')).toEqual({ id: '12', sufijo: '' });
        expect(leerClaveDeTrabajo('bull:q:12:logs', 'q')).toEqual({ id: '12', sufijo: 'logs' });
        expect(leerClaveDeTrabajo('bull:q:completed', 'q')).toBeNull();
        expect(leerClaveDeTrabajo('bull:q:content-abc', 'q')).toBeNull();
    });

    it('simula: cuenta lo suelto y antiguo sin borrar nada', async () => {
        const redis = redisFalso({
            claves: {
                'bull:q:1': { timestamp: antiguo }, 'bull:q:2': { timestamp: antiguo }, 'bull:q:2:logs': {},
                'bull:q:3': { timestamp: reciente }, 'bull:q:4': { timestamp: antiguo }, 'bull:q:completed': {},
            },
            zsets: { 'bull:q:completed': ['4'] },
        });
        const r = await limpiarTrabajosSueltos(redis, 'q');
        expect(r).toMatchObject({ simulacion: true, sueltas: 3, sueltasAntiguas: 2, borradas: 0 });
        expect(redis.unlink).not.toHaveBeenCalled();
    });

    it('nunca borra lo que una lista menciona ni lo reciente', async () => {
        const redis = redisFalso({
            claves: { 'bull:q:1': { timestamp: antiguo }, 'bull:q:2': { timestamp: antiguo }, 'bull:q:3': { timestamp: reciente }, 'bull:q:4': { timestamp: antiguo }, 'bull:q:5': { timestamp: antiguo } },
            zsets: { 'bull:q:delayed': ['4'] },
            listas: { 'bull:q:active': ['5'] },
        });
        const r = await limpiarTrabajosSueltos(redis, 'q', { ejecutar: true });
        expect(r.borradas).toBe(2);
        expect(Object.keys(redis.claves).sort()).toEqual(['bull:q:3', 'bull:q:4', 'bull:q:5']);
    });

    it('borra también las claves auxiliares del trabajo y respeta el tope', async () => {
        const redis = redisFalso({ claves: { 'bull:q:1': { timestamp: antiguo }, 'bull:q:1:logs': {}, 'bull:q:2': { timestamp: antiguo } } });
        const r = await limpiarTrabajosSueltos(redis, 'q', { ejecutar: true, max: 1 });
        expect(r.borradas).toBe(2);
        expect(Object.keys(redis.claves)).toEqual(['bull:q:2']);
    });
});
