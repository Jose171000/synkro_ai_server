import { BatchNotificationService } from './batch-notification.service';

/**
 * El avance de una carga masiva: se puede consultar mientras corre y también un rato después de terminar (con los números
 * finales), y solo lo ve quien la subió.
 */
function redisEnMemoria() {
    const hashes = new Map<string, Record<string, string>>();
    const vence = new Map<string, number>();
    return {
        hashes, vence,
        hsetnx: jest.fn(async (k: string, f: string, v: string) => { const h = hashes.get(k) ?? {}; if (!(f in h)) h[f] = v; hashes.set(k, h); return 1; }),
        hincrby: jest.fn(async (k: string, f: string, n: number) => { const h = hashes.get(k) ?? {}; h[f] = String(Number(h[f] ?? 0) + n); hashes.set(k, h); return Number(h[f]); }),
        hget: jest.fn(async (k: string, f: string) => hashes.get(k)?.[f] ?? null),
        hgetall: jest.fn(async (k: string) => hashes.get(k) ?? {}),
        expire: jest.fn(async (k: string, s: number) => { vence.set(k, s); return 1; }),
        del: jest.fn(async (k: string) => { hashes.delete(k); return 1; }),
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

    it('solo lo ve quien subió la carga; una carga desconocida devuelve null', async () => {
        const { servicio } = construir();
        await servicio.iniciar('lote-1', 3, 'u1');
        expect(await servicio.progreso('lote-1', 'otro-usuario')).toBeNull();
        expect(await servicio.progreso('no-existe', 'u1')).toBeNull();
    });
});
