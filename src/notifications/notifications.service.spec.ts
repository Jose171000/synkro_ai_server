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

    describe('tienda del aviso', () => {
        const PRODUCTO = '11111111-1111-4111-8111-111111111111';
        const CUENTA = '22222222-2222-4222-8222-222222222222';
        function repoCon(filasPorTabla: Record<string, any[]>) {
            const guardados: any[] = [];
            const consultas: string[] = [];
            const repo = {
                create: (d: any) => d,
                save: async (d: any) => { guardados.push(d); return d; },
                manager: { query: async (sql: string) => { consultas.push(sql); const t = Object.keys(filasPorTabla).find(k => sql.includes(k)); return t ? filasPorTabla[t] : []; } },
            };
            return { repo, guardados, consultas };
        }

        it('toma la tienda del producto del aviso', async () => {
            const { repo, guardados } = repoCon({ 'FROM products': [{ storeId: 'tienda-1' }] });
            await servicio(repo).notify('u', { type: 'sale', title: 'Venta', body: 'x', meta: { productId: PRODUCTO } });
            expect(guardados[0].store).toEqual({ id: 'tienda-1' });
        });

        it('sin producto, usa la tienda de la cuenta del canal', async () => {
            const { repo, guardados } = repoCon({ 'FROM marketplace_connections': [{ storeId: 'tienda-2' }] });
            await servicio(repo).notify('u', { type: 'connection', title: 'Cuenta', body: 'x', meta: { connectionId: CUENTA } });
            expect(guardados[0].store).toEqual({ id: 'tienda-2' });
        });

        it('un envío en lote de Falabella se asocia a su tienda por el id del feed', async () => {
            const { repo, guardados } = repoCon({ marketplace_feeds: [{ storeId: 'tienda-3' }] });
            await servicio(repo).notify('u', { type: 'publish', title: 'Falabella publicó', body: 'x', meta: { feedId: 'abc' } });
            expect(guardados[0].store).toEqual({ id: 'tienda-3' });
        });

        it('la tienda indicada gana sobre la deducida y no consulta nada', async () => {
            const { repo, guardados, consultas } = repoCon({ 'FROM products': [{ storeId: 'otra' }] });
            await servicio(repo).notify('u', { type: 'import', title: 'Importación', body: 'x', storeId: 'tienda-4', meta: { productId: PRODUCTO } });
            expect(guardados[0].store).toEqual({ id: 'tienda-4' });
            expect(consultas).toHaveLength(0);
        });

        it('un dato que no es un id no se consulta (nunca llega a la base)', async () => {
            const { repo, guardados, consultas } = repoCon({});
            await servicio(repo).notify('u', { type: 'sale', title: 'Venta', body: 'x', meta: { productId: "x'; DROP TABLE products;--" } });
            expect(consultas).toHaveLength(0);
            expect(guardados[0].store).toBeNull();
        });

        it('si deducir la tienda falla, el aviso se guarda igual, sin tienda', async () => {
            const guardados: any[] = [];
            const repo = { create: (d: any) => d, save: async (d: any) => { guardados.push(d); return d; }, manager: { query: async () => { throw new Error('base caída'); } } };
            await servicio(repo).notify('u', { type: 'sale', title: 'Venta', body: 'x', meta: { productId: PRODUCTO } });
            expect(guardados).toHaveLength(1);
            expect(guardados[0].store).toBeNull();
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
                leftJoin() { return this; },
                addSelect() { return this; },
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
                leftJoin() { return this; },
                addSelect() { return this; },
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
