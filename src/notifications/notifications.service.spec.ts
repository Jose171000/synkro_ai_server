import { NotificationsService } from './notifications.service';

/**
 * Lo que más importa de este servicio es que nunca estorbe: si guardar un
 * aviso falla, la venta o la publicación que lo originó deben seguir su
 * curso igual.
 */
describe('servicio de notificaciones', () => {
    function servicio(repo: any) {
        return new NotificationsService(repo as any);
    }

    it('guarda el aviso con los datos del suceso', async () => {
        const guardados: any[] = [];
        const repo = {
            create: (d: any) => d,
            save: async (d: any) => { guardados.push(d); return d; },
        };

        await servicio(repo).notify('user-1', {
            type: 'sale',
            severity: 'success',
            title: 'Venta en Mercado Libre',
            body: 'Pedido 123',
            marketplace: 'mercadolibre',
            meta: { orderId: '123' },
        });

        expect(guardados).toHaveLength(1);
        expect(guardados[0]).toMatchObject({
            type: 'sale',
            severity: 'success',
            marketplace: 'mercadolibre',
            meta: { orderId: '123' },
            owner: { id: 'user-1' },
        });
    });

    it('por defecto el aviso es informativo', async () => {
        const guardados: any[] = [];
        const repo = { create: (d: any) => d, save: async (d: any) => { guardados.push(d); return d; } };

        await servicio(repo).notify('user-1', { type: 'system', title: 'Hola', body: 'Texto' });

        expect(guardados[0].severity).toBe('info');
    });

    it('NO revienta si la base falla: el suceso que lo originó debe continuar', async () => {
        const repo = {
            create: (d: any) => d,
            save: async () => { throw new Error('base caída'); },
        };

        await expect(
            servicio(repo).notify('user-1', { type: 'sale', title: 'Venta', body: 'x' }),
        ).resolves.toBeUndefined();
    });

    it('devuelve los avisos junto al número de no leídos', async () => {
        const items = [{ id: 'a' }, { id: 'b' }];
        const repo = {
            createQueryBuilder: () => ({
                where() { return this; },
                orderBy() { return this; },
                take() { return this; },
                andWhere() { return this; },
                getMany: async () => items,
            }),
            count: async () => 7,
        };

        expect(await servicio(repo).list('user-1')).toEqual({ items, unread: 7 });
    });

    it('nunca pide más de 100 de una vez', async () => {
        let pedidos = 0;
        const repo = {
            createQueryBuilder: () => ({
                where() { return this; },
                orderBy() { return this; },
                take(n: number) { pedidos = n; return this; },
                andWhere() { return this; },
                getMany: async () => [],
            }),
            count: async () => 0,
        };

        await servicio(repo).list('user-1', { limit: 5000 });
        expect(pedidos).toBe(100);
    });

    it('solo deja marcar como leído un aviso propio', async () => {
        const repo = { update: async () => ({ affected: 0 }) };
        await expect(servicio(repo).markRead('user-1', 'de-otro')).rejects.toThrow(/no encontrada/i);
    });

    it('solo deja borrar un aviso propio', async () => {
        const repo = { delete: async () => ({ affected: 0 }) };
        await expect(servicio(repo).remove('user-1', 'de-otro')).rejects.toThrow(/no encontrada/i);
    });
});
