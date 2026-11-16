import { CategoriaUnicaDeLote, RedisMinimo } from './categoria-unica-de-lote';

/** Un Redis de mentira: set con NX y get, sin caducidad. */
function redisFalso(): RedisMinimo & { datos: Map<string, string> } {
    const datos = new Map<string, string>();
    return {
        datos,
        async set(clave: string, valor: string, ...args: any[]) {
            if (args.includes('NX') && datos.has(clave)) return null;
            datos.set(clave, valor);
            return 'OK';
        },
        async get(clave: string) { return datos.has(clave) ? datos.get(clave)! : null; },
    };
}

describe('categoría única por grupo en la carga masiva', () => {
    const rapido = { esperaMaxMs: 300, sondeoMs: 10 };

    it('el primero en pedir el turno decide; los demás usan lo que publica, aunque pidan a la vez', async () => {
        const redis = redisFalso();
        const c = new CategoriaUnicaDeLote(null as any);
        const jefe = await c.turno('L1', 'AIDA', 'job-1', { ...rapido, redis });
        expect(jefe).toEqual({ rol: 'jefe' });

        const seguidor = c.turno('L1', 'AIDA', 'job-2', { ...rapido, esperaMaxMs: 2000, redis });
        await new Promise((r) => setTimeout(r, 30));
        await c.publicar('L1', 'AIDA', { falabella: '3223', mercadolibre: 'MPE1' }, redis);
        expect(await seguidor).toEqual({ rol: 'seguidor', categorias: { falabella: '3223', mercadolibre: 'MPE1' } });
    });

    it('un grupo distinto, u otro lote, tiene su propio jefe', async () => {
        const redis = redisFalso();
        const c = new CategoriaUnicaDeLote(null as any);
        expect((await c.turno('L1', 'AIDA', 'a', { ...rapido, redis })).rol).toBe('jefe');
        expect((await c.turno('L1', 'CLOE', 'b', { ...rapido, redis })).rol).toBe('jefe');
        expect((await c.turno('L2', 'AIDA', 'c', { ...rapido, redis })).rol).toBe('jefe');
    });

    it('un reintento del mismo trabajo vuelve a ser el jefe', async () => {
        const redis = redisFalso();
        const c = new CategoriaUnicaDeLote(null as any);
        await c.turno('L1', 'AIDA', 'job-1', { ...rapido, redis });
        expect((await c.turno('L1', 'AIDA', 'job-1', { ...rapido, redis })).rol).toBe('jefe');
    });

    it('si el jefe falla, los demás no esperan: siguen por su cuenta', async () => {
        const redis = redisFalso();
        const c = new CategoriaUnicaDeLote(null as any);
        await c.turno('L1', 'AIDA', 'job-1', { ...rapido, redis });
        await c.fallo('L1', 'AIDA', redis);
        expect(await c.turno('L1', 'AIDA', 'job-2', { ...rapido, redis })).toEqual({ rol: 'solo' });
    });

    it('si el jefe no publica a tiempo, el seguidor sigue por su cuenta', async () => {
        const redis = redisFalso();
        const c = new CategoriaUnicaDeLote(null as any);
        await c.turno('L1', 'AIDA', 'job-1', { ...rapido, redis });
        expect(await c.turno('L1', 'AIDA', 'job-2', { ...rapido, redis })).toEqual({ rol: 'solo' });
    });
});
