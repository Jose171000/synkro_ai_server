import { BulkBatchService } from './bulk-batch.service';

/** Repositorios en memoria: lo justo para ver qué se anota y qué se lee. */
function construir() {
    const lotes: any[] = [];
    const items: any[] = [];
    const repoLotes: any = {
        create: (d: any) => ({ ...d }),
        save: jest.fn(async (l: any) => { lotes.push(l); return l; }),
        update: jest.fn(async (where: any, cambios: any) => { Object.assign(lotes.find((l) => l.id === where.id) ?? {}, cambios); }),
        findOne: jest.fn(async ({ where }: any) => lotes.find((l) => l.id === where.id) ?? null),
    };
    const repoItems: any = {
        create: (d: any) => ({ ...d }),
        save: jest.fn(async (lista: any[]) => { items.push(...lista); return lista; }),
        update: jest.fn(async (where: any, cambios: any) => { items.filter((i) => i.batchId === where.batchId && i.sku === where.sku).forEach((i) => Object.assign(i, cambios)); }),
        find: jest.fn(async ({ where }: any) => items.filter((i) => i.batchId === where.batchId)),
    };
    return { service: new BulkBatchService(repoLotes, repoItems), lotes, items, repoLotes, repoItems };
}

const datos = (n: number) => Array.from({ length: n }, (_, i) => ({ sku: `SKU-${i}`, payload: { sku: `SKU-${i}`, price: 10 } }));

describe('registro durable de las cargas masivas', () => {
    it('anota el lote y un renglón pendiente por producto, con lo necesario para reintentarlo', async () => {
        const { service, lotes, items } = construir();
        await service.crear('b1', 'u1', 's1', datos(3), ['Fila 5: falta el precio']);
        expect(lotes[0]).toMatchObject({ id: 'b1', userId: 'u1', storeId: 's1', total: 3, status: 'running', rejected: ['Fila 5: falta el precio'] });
        expect(items.map((i) => [i.sku, i.status])).toEqual([['SKU-0', 'pendiente'], ['SKU-1', 'pendiente'], ['SKU-2', 'pendiente']]);
        expect(items[0].payload).toEqual({ sku: 'SKU-0', price: 10 });
    });

    it('un lote grande se anota en tandas de 200 renglones', async () => {
        const { service, items, repoItems } = construir();
        await service.crear('b1', 'u1', undefined, datos(450));
        expect(repoItems.save).toHaveBeenCalledTimes(3);
        expect(items).toHaveLength(450);
    });

    it('marca cada producto como listo o fallido y el resumen lo cuenta', async () => {
        const { service } = construir();
        await service.crear('b1', 'u1', 's1', datos(3), ['Fila 9: SKU repetido']);
        await service.marcar('b1', 'SKU-0', { ok: true, productId: 'p0' });
        await service.marcar('b1', 'SKU-1', { ok: false, error: 'DeepSeek no respondió' });
        let r = await service.resumen('b1', 'u1');
        expect(r).toMatchObject({ total: 3, processed: 1, failed: 1, terminado: false, rechazadas: ['Fila 9: SKU repetido'] });
        expect(r!.fallidos).toEqual([{ sku: 'SKU-1', error: 'DeepSeek no respondió' }]);

        await service.marcar('b1', 'SKU-2', { ok: true, productId: 'p2' });
        r = await service.resumen('b1', 'u1');
        expect(r!.terminado).toBe(true);
    });

    it('un reintento que sale bien borra el error del intento anterior', async () => {
        const { service, items } = construir();
        await service.crear('b1', 'u1', 's1', datos(1));
        await service.marcar('b1', 'SKU-0', { ok: false, error: 'timeout' });
        await service.marcar('b1', 'SKU-0', { ok: true, productId: 'p0' });
        expect(items[0]).toMatchObject({ status: 'listo', error: null, productId: 'p0' });
    });

    it('cerrar deja el lote como terminado, aunque falte algún renglón', async () => {
        const { service, lotes } = construir();
        await service.crear('b1', 'u1', 's1', datos(2));
        await service.cerrar('b1');
        expect(lotes[0].status).toBe('done');
        expect(lotes[0].finishedAt).toBeInstanceOf(Date);
        expect((await service.resumen('b1', 'u1'))!.terminado).toBe(true);
    });

    it('solo quien subió el lote lo ve, y uno que no existe da null', async () => {
        const { service } = construir();
        await service.crear('b1', 'u1', 's1', datos(1));
        expect(await service.resumen('b1', 'otro')).toBeNull();
        expect(await service.resumen('no-existe', 'u1')).toBeNull();
    });

    it('si la base falla no lanza: crear un producto no se puede tumbar por no poder anotarlo', async () => {
        const { service, repoLotes, repoItems } = construir();
        repoLotes.save.mockRejectedValue(new Error('base caída'));
        repoItems.update.mockRejectedValue(new Error('base caída'));
        repoLotes.update.mockRejectedValue(new Error('base caída'));
        await expect(service.crear('b1', 'u1', 's1', datos(1))).resolves.toBeUndefined();
        await expect(service.marcar('b1', 'SKU-0', { ok: true })).resolves.toBeUndefined();
        await expect(service.cerrar('b1')).resolves.toBeUndefined();
    });
});
