import { ConflictException } from '@nestjs/common';
import { CreacionUnica, RedisDeCreacion, huellaDeCreacion } from './creacion-unica';

function redisFalso(): RedisDeCreacion & { datos: Map<string, string> } {
    const datos = new Map<string, string>();
    return {
        datos,
        async set(clave: string, valor: string, ...args: any[]) {
            if (args.includes('NX') && datos.has(clave)) return null;
            datos.set(clave, valor);
            return 'OK';
        },
        async get(clave: string) { return datos.has(clave) ? datos.get(clave)! : null; },
        async del(clave: string) { datos.delete(clave); return 1; },
    };
}

describe('huella de una creación con IA', () => {
    const foto = (t: string) => Buffer.from(t);

    it('las mismas fotos y datos dan la misma huella, sin importar el orden de las fotos ni el nombre de archivo', () => {
        const a = huellaDeCreacion([foto('uno'), foto('dos')], { name: 'Disco', price: 1000 });
        const b = huellaDeCreacion([foto('dos'), foto('uno')], { price: 1000, name: ' Disco ' });
        expect(a).toBe(b);
    });

    it('otra foto, otro precio u otro texto dan otra huella', () => {
        const base = huellaDeCreacion([foto('uno')], { name: 'Disco', price: 1000 });
        expect(huellaDeCreacion([foto('otra')], { name: 'Disco', price: 1000 })).not.toBe(base);
        expect(huellaDeCreacion([foto('uno')], { name: 'Disco', price: 900 })).not.toBe(base);
        expect(huellaDeCreacion([foto('uno')], { name: 'Disco 2', price: 1000 })).not.toBe(base);
    });

    it('un campo vacío no cambia la huella', () => {
        expect(huellaDeCreacion([foto('uno')], { name: 'Disco', sku: '' })).toBe(huellaDeCreacion([foto('uno')], { name: 'Disco' }));
    });
});

describe('CreacionUnica', () => {
    const nuevo = () => ({ c: new CreacionUnica(null as any), redis: redisFalso() });
    const existente = (productos: Record<string, any>) => jest.fn(async (id: string) => productos[id] ?? null);

    it('la primera vez crea y recuerda el producto; la segunda devuelve el mismo sin crear otro', async () => {
        const { c, redis } = nuevo();
        const crear = jest.fn(async () => ({ id: 'p1', sku: 'PSI-0001' }));
        const ex = existente({ p1: { id: 'p1', sku: 'PSI-0001' } });
        const a = await c.unaSolaVez('t1', 'h', crear, ex, redis);
        const b = await c.unaSolaVez('t1', 'h', crear, ex, redis);
        expect(crear).toHaveBeenCalledTimes(1);
        expect(b).toEqual(a);
    });

    it('si el primero aún se está generando, avisa en vez de crear otro', async () => {
        const { c, redis } = nuevo();
        let liberar!: () => void;
        const crear = jest.fn(() => new Promise<{ id: string }>((r) => { liberar = () => r({ id: 'p1' }); }));
        const primero = c.unaSolaVez('t1', 'h', crear, existente({}), redis);
        await new Promise((r) => setTimeout(r, 5));
        await expect(c.unaSolaVez('t1', 'h', crear, existente({}), redis)).rejects.toBeInstanceOf(ConflictException);
        liberar();
        await primero;
        expect(crear).toHaveBeenCalledTimes(1);
    });

    it('si la creación falla, se libera para poder reintentar', async () => {
        const { c, redis } = nuevo();
        await expect(c.unaSolaVez('t1', 'h', async () => { throw new Error('la IA falló'); }, existente({}), redis)).rejects.toThrow('la IA falló');
        const crear = jest.fn(async () => ({ id: 'p2' }));
        await c.unaSolaVez('t1', 'h', crear, existente({}), redis);
        expect(crear).toHaveBeenCalledTimes(1);
    });

    it('si el producto recordado ya no existe (lo eliminaron), se crea de nuevo', async () => {
        const { c, redis } = nuevo();
        await c.unaSolaVez('t1', 'h', async () => ({ id: 'p1' }), existente({}), redis);
        const crear = jest.fn(async () => ({ id: 'p3' }));
        const r = await c.unaSolaVez('t1', 'h', crear, existente({}), redis);
        expect(r.id).toBe('p3');
        expect(crear).toHaveBeenCalledTimes(1);
    });

    it('tiendas distintas no se bloquean entre sí', async () => {
        const { c, redis } = nuevo();
        const crear = jest.fn(async () => ({ id: 'x' }));
        await c.unaSolaVez('t1', 'h', crear, existente({}), redis);
        await c.unaSolaVez('t2', 'h', crear, existente({}), redis);
        expect(crear).toHaveBeenCalledTimes(2);
    });

    it('si Redis falla no impide crear', async () => {
        const c = new CreacionUnica(null as any);
        const roto: RedisDeCreacion = { set: async () => { throw new Error('sin redis'); }, get: async () => { throw new Error('sin redis'); }, del: async () => { throw new Error('sin redis'); } };
        const crear = jest.fn(async () => ({ id: 'p1' }));
        expect((await c.unaSolaVez('t1', 'h', crear, existente({}), roto)).id).toBe('p1');
    });
});
