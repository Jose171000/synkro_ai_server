import { BatchNotificationService } from './batch-notification.service';

/**
 * El avance de una carga masiva: se puede consultar mientras corre y también un rato después de terminar (con los números
 * finales), y solo lo ve quien la subió.
 */
function redisEnMemoria() {
    const hashes = new Map<string, Record<string, string>>();
    const vence = new Map<string, number>();
    const hsetnx = (k: string, f: string, v: string) => { const h = hashes.get(k) ?? {}; if (!(f in h)) h[f] = v; hashes.set(k, h); return 1; };
    const hincrby = (k: string, f: string, n: number) => { const h = hashes.get(k) ?? {}; h[f] = String(Number(h[f] ?? 0) + n); hashes.set(k, h); return Number(h[f]); };
    const hmget = (k: string, ...campos: string[]) => campos.map((f) => hashes.get(k)?.[f] ?? null);
    const expire = (k: string, s: number) => { vence.set(k, s); return 1; };
    return {
        hashes, vence,
        hsetnx: jest.fn(async (k: string, f: string, v: string) => hsetnx(k, f, v)),
        hincrby: jest.fn(async (k: string, f: string, n: number) => hincrby(k, f, n)),
        hget: jest.fn(async (k: string, f: string) => hashes.get(k)?.[f] ?? null),
        hgetall: jest.fn(async (k: string) => hashes.get(k) ?? {}),
        expire: jest.fn(async (k: string, s: number) => expire(k, s)),
        del: jest.fn(async (k: string) => { hashes.delete(k); return 1; }),
        // Como Redis: los comandos de una transacción se ejecutan seguidos, sin que otra se cuele en medio.
        multi: jest.fn(() => {
            const cola: (() => unknown)[] = [];
            const tx: any = {
                hsetnx: (...a: [string, string, string]) => { cola.push(() => hsetnx(...a)); return tx; },
                hincrby: (...a: [string, string, number]) => { cola.push(() => hincrby(...a)); return tx; },
                hmget: (...a: [string, ...string[]]) => { cola.push(() => hmget(...a)); return tx; },
                expire: (...a: [string, number]) => { cola.push(() => expire(...a)); return tx; },
                exec: async () => { await Promise.resolve(); return cola.map((c) => [null, c()]); },
            };
            return tx;
        }),
    };
}

describe('avance de una carga masiva', () => {
    const construir = () => {
        const redis = redisEnMemoria();
        const correo = { sendJobCompleted: jest.fn(async () => undefined) };
        return { servicio: new BatchNotificationService(redis as any, correo as any), redis, correo };
    };
    const meta = { batchId: 'lote-1', batchTotal: 3, userEmail: 'a@b.com', jobType: 'Creación masiva de productos' };

    it('se puede consultar desde que se sube, antes de que termine el primer producto', async () => {
        const { servicio } = construir();
        await servicio.iniciar('lote-1', 3, 'u1');
        expect(await servicio.progreso('lote-1', 'u1')).toEqual({ total: 3, processed: 0, failed: 0, terminado: false });
    });

    it('cuenta los que van listos y los que fallaron', async () => {
        const { servicio } = construir();
        await servicio.iniciar('lote-1', 3, 'u1');
        await servicio.trackAndNotify(meta, true);
        await servicio.trackAndNotify(meta, false);
        expect(await servicio.progreso('lote-1', 'u1')).toEqual({ total: 3, processed: 1, failed: 1, terminado: false });
    });

    it('al terminar sigue consultable (con los números finales) y avisa por correo una sola vez', async () => {
        const { servicio, redis, correo } = construir();
        await servicio.iniciar('lote-1', 3, 'u1');
        const resultados = [await servicio.trackAndNotify(meta, true), await servicio.trackAndNotify(meta, true), await servicio.trackAndNotify(meta, false)];
        expect(resultados).toEqual([false, false, true]);
        expect(await servicio.progreso('lote-1', 'u1')).toEqual({ total: 3, processed: 2, failed: 1, terminado: true });
        expect(redis.del).not.toHaveBeenCalled();
        expect(redis.vence.get('batch:lote-1')).toBe(3600); // se conserva una hora
        expect(correo.sendJobCompleted).toHaveBeenCalledTimes(1);
    });

    it('con muchos productos terminando a la vez, el lote se cierra una sola vez y el correo sale una sola vez', async () => {
        const { servicio, correo } = construir();
        const lote = { ...meta, batchId: 'lote-20', batchTotal: 20 };
        await servicio.iniciar('lote-20', 20, 'u1');
        const resultados = await Promise.all(Array.from({ length: 20 }, (_, i) => servicio.trackAndNotify(lote, i % 5 !== 0)));
        expect(resultados.filter(Boolean)).toHaveLength(1);
        expect(await servicio.progreso('lote-20', 'u1')).toEqual({ total: 20, processed: 16, failed: 4, terminado: true });
        expect(correo.sendJobCompleted).toHaveBeenCalledTimes(1);
    });

    it('un aviso de más después de cerrado (un reintento tardío) no vuelve a cerrar el lote', async () => {
        const { servicio, correo } = construir();
        await servicio.iniciar('lote-1', 3, 'u1');
        for (let i = 0; i < 3; i++) await servicio.trackAndNotify(meta, true);
        expect(await servicio.trackAndNotify(meta, true)).toBe(false);
        expect(correo.sendJobCompleted).toHaveBeenCalledTimes(1);
    });

    it('si Redis no responde, avisa del error en vez de dar el lote por cerrado', async () => {
        const { servicio, redis, correo } = construir();
        redis.multi.mockReturnValueOnce({ hsetnx() { return this; }, hincrby() { return this; }, hmget() { return this; }, expire() { return this; }, exec: async () => null } as any);
        await expect(servicio.trackAndNotify(meta, true)).rejects.toThrow(/No se pudo actualizar el avance/);
        expect(correo.sendJobCompleted).not.toHaveBeenCalled();
    });

    it('solo lo ve quien subió la carga; una carga desconocida devuelve null', async () => {
        const { servicio } = construir();
        await servicio.iniciar('lote-1', 3, 'u1');
        expect(await servicio.progreso('lote-1', 'otro-usuario')).toBeNull();
        expect(await servicio.progreso('no-existe', 'u1')).toBeNull();
    });
});
