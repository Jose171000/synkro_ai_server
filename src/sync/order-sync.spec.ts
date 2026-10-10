import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { SyncService } from './sync.service';
import { MarketplaceConnection } from './entities/marketplace-connection.entity';
import { ListingLink } from './entities/listing-link.entity';
import { MarketplaceOrder } from './entities/marketplace-order.entity';
import { MarketplaceFeed } from './falabella/entities/marketplace-feed.entity';
import { Product } from '../products/entities/product.entity';
import { MeliApiService } from './meli/meli-api.service';
import { YavendioApiService } from './yavendio/yavendio-api.service';
import { FalabellaApiService } from './falabella/falabella-api.service';
import { NotificationsService } from '../notifications/notifications.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { ChangeRequestsService } from './change-requests.service';
import { StoresService } from '../stores/stores.service';

/**
 * Las ventas entran solas y una sola vez. Lo que se protege: cada venta queda
 * en SU tienda y cuenta, el stock baja una sola vez aunque la venta se vea
 * varias veces (aviso + consulta periódica), el nuevo stock se avisa a las
 * demás cuentas, y una cuenta caída no impide revisar las otras.
 */
const cuenta = (over: any = {}) => ({
    id: 'c1', marketplace: 'falabella', externalUserId: 'vendedor@x.com', accessToken: 'clave', status: 'active',
    currency: 'PEN', label: null, externalNickname: 'vendedor@x.com',
    owner: { id: 'u1' }, store: { id: 't1' }, createdAt: new Date(), ...over,
});

async function construir(opts: { conexiones?: any[]; producto?: any; enlaces?: any[] } = {}) {
    const conexiones = opts.conexiones ?? [cuenta()];
    const producto = opts.producto ?? { id: 'p1', sku: 'SKU-1', name: 'Gafas', stock: 5 };
    const ventas: any[] = [];
    const trabajos: any[] = [];
    const aplicadas = new Set<string>();
    const avisos: any[] = [];

    const repoConexiones = {
        find: jest.fn(async ({ where }: any) => {
            const filtros = Array.isArray(where) ? where : [where];
            return conexiones.filter(c => filtros.some((f: any) =>
                (!f.marketplace || c.marketplace === f.marketplace) &&
                (!f.status || c.status === f.status) &&
                (!f.store || c.store.id === f.store.id)));
        }),
        findOne: jest.fn(async ({ where }: any) => conexiones.find(c => c.id === where.id) ?? null),
        save: jest.fn(async (c: any) => c),
        update: jest.fn(),
    };
    const repoVentas = {
        findOne: jest.fn(async ({ where }: any) => ventas.find(v => v.externalId === where.externalId) ?? null),
        create: jest.fn((d: any) => ({ ...d })),
        save: jest.fn(async (v: any) => { ventas.push(v); return v; }),
    };
    const repoProductos = {
        findOne: jest.fn(async () => producto),
        save: jest.fn(async (p: any) => p),
    };
    const repoEnlaces = {
        findOne: jest.fn(async () => (opts.enlaces ?? [{ product: producto }])[0]),
        find: jest.fn(async () => []),
    };
    const vacio = { findOne: jest.fn(), find: jest.fn(), save: jest.fn(), create: jest.fn() };
    const redis = {
        // Como Redis: el primer SET con NX gana; los siguientes devuelven null.
        set: jest.fn(async (clave: string) => { if (aplicadas.has(clave)) return null; aplicadas.add(clave); return 'OK'; }),
        get: jest.fn(), setex: jest.fn(), del: jest.fn(),
    };
    const falabella = {
        getOrders: jest.fn().mockResolvedValue([]),
        getOrderItems: jest.fn().mockResolvedValue([]),
    };
    const meli = { searchOrders: jest.fn().mockResolvedValue([]), getOrder: jest.fn(), refreshTokens: jest.fn() };

    const modulo = await Test.createTestingModule({
        providers: [
            SyncService,
            { provide: getRepositoryToken(MarketplaceConnection), useValue: repoConexiones },
            { provide: getRepositoryToken(ListingLink), useValue: repoEnlaces },
            { provide: getRepositoryToken(MarketplaceOrder), useValue: repoVentas },
            { provide: getRepositoryToken(MarketplaceFeed), useValue: vacio },
            { provide: getRepositoryToken(Product), useValue: repoProductos },
            { provide: getQueueToken('marketplace-sync-queue'), useValue: { add: jest.fn(async (n: string, d: any) => { trabajos.push({ n, d }); }) } },
            { provide: REDIS_CLIENT, useValue: redis },
            { provide: MeliApiService, useValue: meli },
            { provide: YavendioApiService, useValue: {} },
            { provide: FalabellaApiService, useValue: falabella },
            { provide: NotificationsService, useValue: { notify: jest.fn(async (u: string, a: any) => { avisos.push({ u, ...a }); }) } },
            { provide: ChangeRequestsService, useValue: {} },
            { provide: StoresService, useValue: {} },
        ],
    }).compile();

    return { service: modulo.get(SyncService), ventas, trabajos, avisos, producto, falabella, meli, repoEnlaces, repoConexiones };
}

const pedidoFalabella = { OrderId: 100, OrderNumber: 9001, Price: '50.00', ItemsCount: 1, CreatedAt: '2026-10-09T12:00:00Z', Statuses: { Status: 'pending' } };
const lineaFalabella = { Sku: 'SKU-1', Name: 'Gafas', PaidPrice: '50.00' };

describe('ventas de Falabella', () => {
    it('una venta nueva queda en su tienda y cuenta, y baja el stock', async () => {
        const { service, ventas, producto, falabella } = await construir();
        falabella.getOrders.mockResolvedValue([pedidoFalabella]);
        falabella.getOrderItems.mockResolvedValue([lineaFalabella]);

        const r = await service.processFalabellaOrders({ userId: 'u1', connectionId: 'c1' });

        expect(r).toMatchObject({ nuevos: 1, repetidos: 0 });
        expect(ventas[0]).toMatchObject({
            marketplace: 'falabella', externalId: '100', store: { id: 't1' }, connection: { id: 'c1' }, owner: { id: 'u1' },
        });
        expect(producto.stock).toBe(4);
    });

    it('la misma venta vista otra vez no se duplica ni baja el stock de nuevo', async () => {
        const { service, ventas, producto, falabella } = await construir();
        falabella.getOrders.mockResolvedValue([pedidoFalabella]);
        falabella.getOrderItems.mockResolvedValue([lineaFalabella]);

        await service.processFalabellaOrders({ userId: 'u1', connectionId: 'c1' });
        const segunda = await service.processFalabellaOrders({ userId: 'u1', connectionId: 'c1' });

        expect(segunda).toMatchObject({ nuevos: 0, repetidos: 1 });
        expect(ventas).toHaveLength(1);
        expect(producto.stock).toBe(4);
    });

    it('avisa de la venta a la persona dueña de la cuenta', async () => {
        const { service, avisos, falabella } = await construir();
        falabella.getOrders.mockResolvedValue([pedidoFalabella]);
        falabella.getOrderItems.mockResolvedValue([lineaFalabella]);

        await service.processFalabellaOrders({ userId: 'u1', connectionId: 'c1' });

        expect(avisos.find(a => a.type === 'sale')).toMatchObject({ u: 'u1', marketplace: 'falabella' });
    });
});

describe('ventas de Mercado Libre', () => {
    const cuentaMl = cuenta({ id: 'ml1', marketplace: 'mercadolibre', externalUserId: '555' });
    const orden = (over: any = {}) => ({
        id: 777, status: 'paid', total_amount: 100, currency_id: 'PEN', date_closed: '2026-10-09T12:00:00Z',
        order_items: [{ item: { id: 'MPE1', seller_sku: 'SKU-1', title: 'Gafas' }, quantity: 2, unit_price: 50 }],
        ...over,
    });

    it('trae las ventas pagadas, descuenta el stock y las deja en su tienda', async () => {
        const { service, ventas, producto, meli } = await construir({ conexiones: [cuentaMl] });
        meli.searchOrders.mockResolvedValue([orden()]);

        const r = await service.pollMeliOrders('ml1');

        expect(r).toEqual({ nuevos: 1, revisados: 1 });
        expect(ventas[0]).toMatchObject({ marketplace: 'mercadolibre', externalId: '777', store: { id: 't1' }, connection: { id: 'ml1' } });
        expect(producto.stock).toBe(3);
    });

    it('consultar dos veces la misma venta (o recibir además el aviso) descuenta el stock una sola vez', async () => {
        const { service, producto, meli } = await construir({ conexiones: [cuentaMl] });
        meli.searchOrders.mockResolvedValue([orden()]);

        await service.pollMeliOrders('ml1');
        const segunda = await service.pollMeliOrders('ml1');

        expect(segunda.nuevos).toBe(0);
        expect(producto.stock).toBe(3);
    });

    it('una venta sin pagar no mueve el stock', async () => {
        const { service, ventas, producto, meli } = await construir({ conexiones: [cuentaMl] });
        meli.searchOrders.mockResolvedValue([orden({ status: 'payment_required' })]);

        const r = await service.pollMeliOrders('ml1');

        expect(r.nuevos).toBe(0);
        expect(ventas).toHaveLength(0);
        expect(producto.stock).toBe(5);
    });

    it('pide a Mercado Libre las ventas de las últimas 48 horas de ESA cuenta', async () => {
        const { service, meli } = await construir({ conexiones: [cuentaMl] });

        await service.pollMeliOrders('ml1');

        const [, vendedor, desde] = meli.searchOrders.mock.calls[0];
        expect(vendedor).toBe('555');
        const horas = (Date.now() - desde.getTime()) / 3600_000;
        expect(horas).toBeGreaterThan(47.9);
        expect(horas).toBeLessThan(48.1);
    });
});

describe('consulta periódica de todas las cuentas', () => {
    it('una cuenta caída no impide revisar las demás', async () => {
        const rota = cuenta({ id: 'rota', marketplace: 'falabella' });
        const buena = cuenta({ id: 'ml-ok', marketplace: 'mercadolibre', externalUserId: '555' });
        const { service, falabella, meli } = await construir({ conexiones: [rota, buena] });
        falabella.getOrders.mockRejectedValue(new Error('Falabella rechazó las credenciales'));
        meli.searchOrders.mockResolvedValue([]);

        const r = await service.pollAllOrders();

        expect(r.cuentas).toHaveLength(2);
        expect(r.cuentas.find(c => c.id === 'rota')?.error).toMatch(/credenciales/);
        expect(r.cuentas.find(c => c.id === 'ml-ok')?.error).toBeUndefined();
        expect(meli.searchOrders).toHaveBeenCalled();
    });

    it('actualizar las ventas de una tienda solo toca las cuentas de esa tienda', async () => {
        const deT1 = cuenta({ id: 'a', marketplace: 'falabella', store: { id: 't1' } });
        const deT2 = cuenta({ id: 'b', marketplace: 'falabella', store: { id: 't2' } });
        const { service, falabella } = await construir({ conexiones: [deT1, deT2] });

        const r = await service.syncStoreOrders('t1');

        expect(r.cuentas.map(c => c.id)).toEqual(['a']);
        expect(falabella.getOrders).toHaveBeenCalledTimes(1);
    });

    it('suma las ventas nuevas de todas las cuentas', async () => {
        const { service, falabella } = await construir();
        falabella.getOrders.mockResolvedValue([pedidoFalabella]);
        falabella.getOrderItems.mockResolvedValue([lineaFalabella]);

        const r = await service.pollAllOrders();

        expect(r.totalNuevos).toBe(1);
    });
});

describe('programación de la consulta periódica', () => {
    const OLD = process.env.ORDER_POLL_MINUTES;
    afterEach(() => { if (OLD === undefined) delete process.env.ORDER_POLL_MINUTES; else process.env.ORDER_POLL_MINUTES = OLD; });

    it('se programa cada 5 minutos por defecto', async () => {
        delete process.env.ORDER_POLL_MINUTES;
        const { service } = await construir();
        const cola = (service as any).syncQueue;
        cola.upsertJobScheduler = jest.fn().mockResolvedValue(undefined);

        await service.onModuleInit();

        expect(cola.upsertJobScheduler).toHaveBeenCalledWith('poll-orders', { every: 300_000 }, expect.objectContaining({ name: 'poll-orders' }));
    });

    it('ORDER_POLL_MINUTES=0 la desactiva', async () => {
        process.env.ORDER_POLL_MINUTES = '0';
        const { service } = await construir();
        const cola = (service as any).syncQueue;
        cola.upsertJobScheduler = jest.fn();

        await service.onModuleInit();

        expect(cola.upsertJobScheduler).not.toHaveBeenCalled();
    });

    it('si Redis falla al programar, el servidor sigue arrancando', async () => {
        const { service } = await construir();
        (service as any).syncQueue.upsertJobScheduler = jest.fn().mockRejectedValue(new Error('redis caído'));

        await expect(service.onModuleInit()).resolves.toBeUndefined();
    });
});
