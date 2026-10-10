import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { NotFoundException } from '@nestjs/common';
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
 * Importar y mantener al día las publicaciones de Mercado Libre y Falabella, y
 * el historial de ventas. Lo que se protege: se enlaza por SKU sin pisar el
 * stock ni el precio de lo que ya existe, cada variante es su producto, la
 * revisión periódica solo toca el espejo del canal, y el historial nunca
 * mueve el stock ni molesta con avisos.
 */

// ── Repositorios en memoria con el mismo criterio de búsqueda que TypeORM ──
function coincide(entidad: any, donde: any): boolean {
    if (Array.isArray(donde)) return donde.some(d => coincide(entidad, d));
    return Object.entries(donde ?? {}).every(([k, v]: [string, any]) => {
        const actual = entidad?.[k];
        if (v && typeof v === 'object' && '_type' in v) return v._type === 'isNull' ? actual == null : true;
        if (v && typeof v === 'object' && !(v instanceof Date)) return actual != null && coincide(actual, v);
        return actual === v;
    });
}

function repoEnMemoria<T extends { id?: string }>(tabla: T[], prefijo: string, relaciones: (e: any) => void = () => { }) {
    return {
        findOne: jest.fn(async ({ where }: any) => { const e = tabla.find(x => coincide(x, where)); if (e) relaciones(e); return e ?? null; }),
        find: jest.fn(async ({ where }: any = {}) => { const r = tabla.filter(x => coincide(x, where ?? {})); r.forEach(relaciones); return r; }),
        create: jest.fn((d: any) => ({ ...d })),
        save: jest.fn(async (e: any) => {
            if (!e.id) { e.id = `${prefijo}-${tabla.length + 1}`; tabla.push(e); }
            else if (!tabla.includes(e)) { const i = tabla.findIndex(x => x.id === e.id); if (i >= 0) tabla[i] = e; else tabla.push(e); }
            return e;
        }),
        update: jest.fn(async (id: string, datos: any) => { Object.assign(tabla.find(x => x.id === id) ?? {}, datos); }),
        count: jest.fn(async ({ where }: any) => tabla.filter(x => coincide(x, where)).length),
        exist: jest.fn(),
    };
}

const MS = (d: Date) => d.getTime();

async function construir(over: { conexiones?: any[]; productos?: any[]; enlaces?: any[] } = {}) {
    const conexiones = over.conexiones ?? [];
    const productos = over.productos ?? [];
    const enlaces = over.enlaces ?? [];
    const ventas: any[] = [];
    const avisos: any[] = [];
    const trabajos: any[] = [];
    const aplicadas = new Set<string>();

    const repoProductos = repoEnMemoria(productos, 'prod');
    const repoEnlaces = repoEnMemoria(enlaces, 'enl');
    const repoVentas = repoEnMemoria(ventas, 'venta');
    const repoConexiones = repoEnMemoria(conexiones, 'con');
    const vacio = { findOne: jest.fn(), find: jest.fn(), save: jest.fn(), create: jest.fn() };

    const meli: any = {
        listSellerItemIds: jest.fn().mockResolvedValue({ ids: [], incompleto: false }),
        getItems: jest.fn().mockResolvedValue({ items: [], notFound: [] }),
        searchOrders: jest.fn().mockResolvedValue([]),
        searchOrdersPage: jest.fn().mockResolvedValue({ results: [], total: 0 }),
        getShipment: jest.fn().mockResolvedValue(null),
        updateItem: jest.fn().mockResolvedValue(undefined),
        getOrder: jest.fn(), refreshTokens: jest.fn(),
    };
    const falabella: any = {
        getAllProducts: jest.fn().mockResolvedValue({ productos: [], incompleto: false }),
        getOrders: jest.fn().mockResolvedValue([]),
        getOrderItems: jest.fn().mockResolvedValue([]),
    };
    const redis = {
        set: jest.fn(async (k: string) => { if (aplicadas.has(k)) return null; aplicadas.add(k); return 'OK'; }),
        get: jest.fn(), setex: jest.fn(), del: jest.fn(),
    };
    const cola = { add: jest.fn(async (n: string, d: any) => { trabajos.push({ n, d }); }), upsertJobScheduler: jest.fn().mockResolvedValue(undefined) };

    const modulo = await Test.createTestingModule({
        providers: [
            SyncService,
            { provide: getRepositoryToken(MarketplaceConnection), useValue: repoConexiones },
            { provide: getRepositoryToken(ListingLink), useValue: repoEnlaces },
            { provide: getRepositoryToken(MarketplaceOrder), useValue: repoVentas },
            { provide: getRepositoryToken(MarketplaceFeed), useValue: vacio },
            { provide: getRepositoryToken(Product), useValue: repoProductos },
            { provide: getQueueToken('marketplace-sync-queue'), useValue: cola },
            { provide: REDIS_CLIENT, useValue: redis },
            { provide: MeliApiService, useValue: meli },
            { provide: YavendioApiService, useValue: {} },
            { provide: FalabellaApiService, useValue: falabella },
            { provide: NotificationsService, useValue: { notify: jest.fn(async (u: string, a: any) => { avisos.push({ u, ...a }); }) } },
            { provide: ChangeRequestsService, useValue: {} },
            { provide: StoresService, useValue: {} },
        ],
    }).compile();

    return { service: modulo.get(SyncService), productos, enlaces, ventas, avisos, trabajos, meli, falabella, cola, repoProductos, repoEnlaces };
}

const SCOPE = { userId: 'u1', storeId: 't1' };
const cuenta = (over: any = {}) => ({
    id: 'ml1', marketplace: 'mercadolibre', externalUserId: '555', externalNickname: 'MI_TIENDA', accessToken: 'tok', status: 'active',
    currency: 'PEN', label: null, owner: { id: 'u1' }, store: { id: 't1' }, createdAt: new Date(), ...over,
});
const itemSimple = (over: any = {}) => ({
    id: 'MPE1', title: 'Reloj', status: 'active', price: 90, currency_id: 'PEN', available_quantity: 7, seller_custom_field: 'REL-01',
    permalink: 'https://ml/1', pictures: [{ id: 'a', secure_url: 'https://img/a.jpg' }], health: 0.8, ...over,
});

describe('importar publicaciones de Mercado Libre', () => {
    it('crea el producto como borrador en la tienda y lo enlaza con su publicación', async () => {
        const { service, meli, productos, enlaces } = await construir({ conexiones: [cuenta()] });
        meli.listSellerItemIds.mockResolvedValue({ ids: ['MPE1'], incompleto: false });
        meli.getItems.mockResolvedValue({ items: [itemSimple()], notFound: [] });

        const r = await service.importMeliListings(SCOPE, undefined);

        expect(r).toMatchObject({ total: 1, nuevas: 1, yaEnCatalogo: 0, enlazadas: 1, sinSku: 0 });
        expect(productos[0]).toMatchObject({ sku: 'REL-01', name: 'Reloj', price: 90, stock: 7, status: 'draft', store: { id: 't1' } });
        expect(productos[0].images).toEqual([{ url: 'https://img/a.jpg' }]);
        expect(enlaces[0]).toMatchObject({
            marketplace: 'mercadolibre', externalId: 'MPE1', variationId: null, syncStatus: 'published',
            lastStockSynced: 7, regularPrice: 90, qualityScore: 80, connection: { id: 'ml1' },
        });
    });

    it('enlaza por SKU un producto que ya existe SIN tocar su stock ni su precio', async () => {
        const existente = { id: 'p1', sku: 'REL-01', name: 'Reloj propio', stock: 20, price: 100, store: { id: 't1' } };
        const { service, meli, productos, enlaces, repoProductos } = await construir({ conexiones: [cuenta()], productos: [existente] });
        meli.listSellerItemIds.mockResolvedValue({ ids: ['MPE1'], incompleto: false });
        meli.getItems.mockResolvedValue({ items: [itemSimple()], notFound: [] });

        const r = await service.importMeliListings(SCOPE, undefined);

        expect(r).toMatchObject({ yaEnCatalogo: 1, nuevas: 0, enlazadas: 1 });
        expect(productos).toHaveLength(1);
        expect(productos[0]).toMatchObject({ stock: 20, price: 100, name: 'Reloj propio' });
        expect(repoProductos.save).not.toHaveBeenCalled();
        expect(enlaces[0].product).toEqual({ id: 'p1' });
        // El canal tiene 7 y Synkro 20: el enlace guarda lo del canal para que el desfase se vea.
        expect(enlaces[0].lastStockSynced).toBe(7);
    });

    it('cada variante con SKU es su propio producto, enlazado a la misma publicación', async () => {
        const { service, meli, productos, enlaces } = await construir({ conexiones: [cuenta()] });
        meli.listSellerItemIds.mockResolvedValue({ ids: ['MPE2'], incompleto: false });
        meli.getItems.mockResolvedValue({
            items: [{
                id: 'MPE2', title: 'Polo', status: 'active', price: 40, available_quantity: 9, pictures: [],
                variations: [
                    { id: 11, price: 40, available_quantity: 4, seller_custom_field: 'POLO-S', attribute_combinations: [{ name: 'Talla', value_name: 'S' }] },
                    { id: 12, price: 40, available_quantity: 5, seller_custom_field: 'POLO-M', attribute_combinations: [{ name: 'Talla', value_name: 'M' }] },
                    { id: 13, price: 40, available_quantity: 0 },
                ],
            }],
            notFound: [],
        });

        const r = await service.importMeliListings(SCOPE, undefined);

        expect(r).toMatchObject({ publicaciones: 1, total: 2, nuevas: 2, sinSku: 1 });
        expect(productos.map(p => [p.sku, p.name, p.stock])).toEqual([['POLO-S', 'Polo - Talla: S', 4], ['POLO-M', 'Polo - Talla: M', 5]]);
        expect(enlaces.map(e => [e.externalId, e.variationId])).toEqual([['MPE2', '11'], ['MPE2', '12']]);
    });

    it('la vista previa no escribe nada', async () => {
        const { service, meli, productos, enlaces, avisos } = await construir({ conexiones: [cuenta()] });
        meli.listSellerItemIds.mockResolvedValue({ ids: ['MPE1'], incompleto: false });
        meli.getItems.mockResolvedValue({ items: [itemSimple()], notFound: [] });

        const r = await service.importMeliListings(SCOPE, undefined, { dryRun: true });

        expect(r).toMatchObject({ total: 1, nuevas: 1, enlazadas: 0 });
        expect(productos).toHaveLength(0);
        expect(enlaces).toHaveLength(0);
        expect(avisos).toHaveLength(0);
    });

    it('un SKU que ya existe en OTRA tienda del dueño no se importa ni se pisa', async () => {
        const ajeno = { id: 'p9', sku: 'REL-01', name: 'De otra tienda', stock: 3, store: { id: 't2' }, owner: { id: 'u1' } };
        const { service, meli, enlaces } = await construir({ conexiones: [cuenta()], productos: [ajeno] });
        meli.listSellerItemIds.mockResolvedValue({ ids: ['MPE1'], incompleto: false });
        meli.getItems.mockResolvedValue({ items: [itemSimple()], notFound: [] });

        const r = await service.importMeliListings(SCOPE, undefined);

        expect(r).toMatchObject({ enOtraTienda: 1, enlazadas: 0 });
        expect(enlaces).toHaveLength(0);
    });

    it('cuenta los estados y avisa si el catálogo se leyó incompleto', async () => {
        const { service, meli } = await construir({ conexiones: [cuenta()] });
        meli.listSellerItemIds.mockResolvedValue({ ids: ['MPE1', 'MPE3'], incompleto: true });
        meli.getItems.mockResolvedValue({ items: [itemSimple(), itemSimple({ id: 'MPE3', seller_custom_field: 'OTRO', status: 'paused' })], notFound: [] });

        const r = await service.importMeliListings(SCOPE, undefined, { dryRun: true });

        expect(r.porEstado).toEqual({ published: 1, paused: 1 });
        expect(r.incompleto).toBe(true);
        expect(r.notaMedia).toBe(80);
    });
});

describe('mantener al día las publicaciones', () => {
    const producto = { id: 'p1', sku: 'REL-01', stock: 20, price: 100 };
    const enlace = (over: any = {}) => ({
        id: 'e1', marketplace: 'mercadolibre', externalId: 'MPE1', variationId: null, syncStatus: 'published',
        lastStockSynced: 20, lastPriceSynced: 100, product: producto, connection: { id: 'ml1' }, ...over,
    });

    it('actualiza el estado, el precio y el stock del canal en cada enlace, sin tocar el producto', async () => {
        const { service, meli, enlaces } = await construir({ conexiones: [cuenta()], productos: [producto], enlaces: [enlace()] });
        meli.getItems.mockResolvedValue({ items: [itemSimple({ status: 'paused', price: 80, available_quantity: 3 })], notFound: [] });

        const r = await service.refreshMeliLinks('ml1');

        expect(r).toEqual({ revisadas: 1, actualizadas: 1, ausentes: 0 });
        expect(enlaces[0]).toMatchObject({ syncStatus: 'paused', lastStockSynced: 3, lastPriceSynced: 80, regularPrice: 80 });
        expect(producto).toMatchObject({ stock: 20, price: 100 }); // lo de Synkro no cambia
    });

    it('una publicación que Mercado Libre ya no conoce queda en pausa con el motivo', async () => {
        const { service, meli, enlaces } = await construir({ conexiones: [cuenta()], productos: [producto], enlaces: [enlace()] });
        meli.getItems.mockResolvedValue({ items: [], notFound: ['MPE1'] });

        const r = await service.refreshMeliLinks('ml1');

        expect(r.ausentes).toBe(1);
        expect(enlaces[0]).toMatchObject({ syncStatus: 'paused', lastError: expect.stringMatching(/ya no existe/) });
    });

    it('si la consulta falla a medias (sin 404), no se da por perdida ninguna publicación', async () => {
        const { service, meli, enlaces } = await construir({ conexiones: [cuenta()], productos: [producto], enlaces: [enlace()] });
        meli.getItems.mockResolvedValue({ items: [], notFound: [] });

        const r = await service.refreshMeliLinks('ml1');

        expect(r).toMatchObject({ actualizadas: 0, ausentes: 0 });
        expect(enlaces[0].syncStatus).toBe('published');
    });

    it('en una publicación con variantes actualiza cada enlace con los datos de SU variante', async () => {
        const p2 = { id: 'p2', sku: 'POLO-M', stock: 5 };
        const { service, meli, enlaces } = await construir({
            conexiones: [cuenta()],
            productos: [producto, p2],
            enlaces: [enlace({ externalId: 'MPE2', variationId: '11' }), enlace({ id: 'e2', externalId: 'MPE2', variationId: '12', product: p2 })],
        });
        meli.getItems.mockResolvedValue({
            items: [{
                id: 'MPE2', title: 'Polo', status: 'active', price: 40, pictures: [],
                variations: [
                    { id: 11, price: 40, available_quantity: 1, seller_custom_field: 'REL-01' },
                    { id: 12, price: 45, available_quantity: 8, seller_custom_field: 'POLO-M' },
                ],
            }],
            notFound: [],
        });

        await service.refreshMeliLinks('ml1');

        expect(enlaces.map(e => [e.variationId, e.lastStockSynced, e.regularPrice])).toEqual([['11', 1, 40], ['12', 8, 45]]);
    });

    it('Falabella: actualiza lo enlazado por SKU con lo que muestra el canal', async () => {
        const fal = cuenta({ id: 'fal1', marketplace: 'falabella', externalUserId: 'v@x.com' });
        const { service, falabella, enlaces } = await construir({
            conexiones: [fal], productos: [producto],
            enlaces: [enlace({ marketplace: 'falabella', externalId: 'SHOP-1', connection: { id: 'fal1' } })],
        });
        falabella.getAllProducts.mockResolvedValue({
            productos: [{
                SellerSku: 'REL-01', QCStatus: 'approved', ContentScore: '95', MainImage: 'https://img/f.jpg',
                BusinessUnits: { BusinessUnit: { Price: '120', SpecialPrice: '99', Stock: '4', Status: 'active', IsPublished: '1' } },
            }],
            incompleto: false,
        });

        const r = await service.refreshFalabellaLinks('fal1');

        expect(r.actualizadas).toBe(1);
        expect(enlaces[0]).toMatchObject({ syncStatus: 'published', lastStockSynced: 4, regularPrice: 120, salePrice: 99, qualityScore: 95, imageUrl: 'https://img/f.jpg' });
    });

    it('Falabella: una ficha ausente solo se pausa si la lectura fue completa', async () => {
        const fal = cuenta({ id: 'fal1', marketplace: 'falabella' });
        const montar = () => construir({
            conexiones: [fal], productos: [producto],
            enlaces: [enlace({ marketplace: 'falabella', connection: { id: 'fal1' } })],
        });

        const completa = await montar();
        completa.falabella.getAllProducts.mockResolvedValue({ productos: [], incompleto: false });
        await completa.service.refreshFalabellaLinks('fal1');
        expect(completa.enlaces[0].syncStatus).toBe('paused');

        const cortada = await montar();
        cortada.falabella.getAllProducts.mockResolvedValue({ productos: [], incompleto: true });
        await cortada.service.refreshFalabellaLinks('fal1');
        expect(cortada.enlaces[0].syncStatus).toBe('published');
    });

    it('una cuenta caída no impide revisar las demás', async () => {
        const rota = cuenta({ id: 'rota', marketplace: 'falabella' });
        const buena = cuenta({ id: 'ml-ok' });
        const { service, falabella, meli } = await construir({ conexiones: [rota, buena], productos: [producto], enlaces: [enlace({ connection: { id: 'ml-ok' } }), enlace({ id: 'e9', marketplace: 'falabella', connection: { id: 'rota' } })] });
        falabella.getAllProducts.mockRejectedValue(new Error('credenciales'));
        meli.getItems.mockResolvedValue({ items: [itemSimple()], notFound: [] });

        const r = await service.refreshAllListings();

        expect(r.cuentas.find(c => c.id === 'rota')?.error).toMatch(/credenciales/);
        expect(r.cuentas.find(c => c.id === 'ml-ok')?.actualizadas).toBe(1);
    });

    it('programa la revisión de publicaciones cada 30 minutos y se puede apagar', async () => {
        const { service, cola } = await construir();
        delete process.env.LISTING_SYNC_MINUTES;
        await service.onModuleInit();
        expect(cola.upsertJobScheduler).toHaveBeenCalledWith('sync-listings', { every: 1_800_000 }, expect.objectContaining({ name: 'sync-listings' }));

        cola.upsertJobScheduler.mockClear();
        process.env.LISTING_SYNC_MINUTES = '0';
        await service.onModuleInit();
        expect(cola.upsertJobScheduler).not.toHaveBeenCalledWith('sync-listings', expect.anything(), expect.anything());
        delete process.env.LISTING_SYNC_MINUTES;
    });
});

describe('stock con variantes de Mercado Libre', () => {
    it('al sincronizar el inventario de una variante, manda el stock de ESA variante', async () => {
        const producto = { id: 'p1', sku: 'POLO-M', stock: 6, price: 45 };
        const { service, meli } = await construir({
            conexiones: [cuenta()], productos: [producto],
            enlaces: [{ id: 'e1', marketplace: 'mercadolibre', externalId: 'MPE2', variationId: '12', syncStatus: 'published', product: producto, connection: { id: 'ml1' } }],
        });

        await service.pushInventoryToMeli('p1', 'ml1');

        expect(meli.updateItem).toHaveBeenCalledWith('tok', 'MPE2', { variations: [{ id: '12', available_quantity: 6, price: 45 }] });
    });

    it('sin variantes manda el stock de la publicación como siempre', async () => {
        const producto = { id: 'p1', sku: 'REL-01', stock: 6, price: 45 };
        const { service, meli } = await construir({
            conexiones: [cuenta()], productos: [producto],
            enlaces: [{ id: 'e1', marketplace: 'mercadolibre', externalId: 'MPE1', variationId: null, syncStatus: 'published', product: producto, connection: { id: 'ml1' } }],
        });

        await service.pushInventoryToMeli('p1', 'ml1');

        expect(meli.updateItem).toHaveBeenCalledWith('tok', 'MPE1', { available_quantity: 6, price: 45 });
    });

    it('una venta de una variante descuenta el stock del producto de ESA variante', async () => {
        const s = { id: 'pS', sku: 'POLO-S', name: 'Polo S', stock: 4 };
        const m = { id: 'pM', sku: 'POLO-M', name: 'Polo M', stock: 5 };
        const { service, meli } = await construir({
            conexiones: [cuenta()], productos: [s, m],
            enlaces: [
                { id: 'e1', marketplace: 'mercadolibre', externalId: 'MPE2', variationId: '11', syncStatus: 'published', product: s, connection: { id: 'ml1' } },
                { id: 'e2', marketplace: 'mercadolibre', externalId: 'MPE2', variationId: '12', syncStatus: 'published', product: m, connection: { id: 'ml1' } },
            ],
        });
        meli.searchOrders.mockResolvedValue([{
            id: 900, status: 'paid', total_amount: 90, currency_id: 'PEN', date_closed: '2026-10-09T12:00:00Z',
            order_items: [{ item: { id: 'MPE2', variation_id: 12, seller_sku: 'POLO-M', title: 'Polo' }, quantity: 2, unit_price: 45 }],
        }]);

        await service.pollMeliOrders('ml1');

        expect(m.stock).toBe(3);
        expect(s.stock).toBe(4);
    });
});

describe('historial de ventas', () => {
    const ordenMl = (id: number, extra: any = {}) => ({
        id, status: 'paid', total_amount: 100, currency_id: 'PEN', date_closed: '2026-08-01T12:00:00Z',
        buyer: { first_name: 'Mario', last_name: 'Vega' }, shipping: { id: 77 },
        order_items: [{ item: { id: 'MPE1', seller_sku: 'REL-01', title: 'Reloj' }, quantity: 1, unit_price: 100 }], ...extra,
    });

    it('Mercado Libre: deja la constancia de la venta sin tocar el stock ni avisar', async () => {
        const producto = { id: 'p1', sku: 'REL-01', name: 'Reloj', stock: 20 };
        const { service, meli, ventas, avisos, trabajos } = await construir({
            conexiones: [cuenta()], productos: [producto],
            enlaces: [{ id: 'e1', marketplace: 'mercadolibre', externalId: 'MPE1', variationId: null, syncStatus: 'published', product: producto, connection: { id: 'ml1' } }],
        });
        meli.searchOrdersPage.mockResolvedValue({ results: [ordenMl(1), ordenMl(2)], total: 2 });

        const r = await service.importOrderHistory(SCOPE, 90);

        expect(r.totalRegistradas).toBe(2);
        expect(ventas.map(v => v.externalId)).toEqual(['1', '2']);
        expect(ventas[0]).toMatchObject({ customerName: 'Mario Vega', store: { id: 't1' }, connection: { id: 'ml1' } });
        expect(producto.stock).toBe(20);
        expect(avisos).toHaveLength(0);
        expect(trabajos.filter(t => t.n === 'inventory')).toHaveLength(0);
        expect(meli.getShipment).not.toHaveBeenCalled();
    });

    it('Mercado Libre: pide solo lo anterior a las últimas 48 horas, que ya cubre la consulta normal', async () => {
        const { service, meli } = await construir({ conexiones: [cuenta()] });

        await service.importOrderHistory(SCOPE, 30);

        const { from, to } = meli.searchOrdersPage.mock.calls[0][2];
        const diasAtras = (Date.now() - MS(from)) / 86_400_000;
        const horasAtras = (Date.now() - MS(to)) / 3_600_000;
        expect(diasAtras).toBeGreaterThan(29.9);
        expect(diasAtras).toBeLessThan(30.1);
        expect(horasAtras).toBeGreaterThan(47.9);
        expect(horasAtras).toBeLessThan(48.1);
    });

    it('importar dos veces el mismo historial no duplica nada', async () => {
        const { service, meli, ventas } = await construir({ conexiones: [cuenta()] });
        meli.searchOrdersPage.mockResolvedValue({ results: [ordenMl(1)], total: 1 });

        await service.importOrderHistory(SCOPE, 90);
        const segunda = await service.importOrderHistory(SCOPE, 90);

        expect(ventas).toHaveLength(1);
        expect(segunda.cuentas[0]).toMatchObject({ registradas: 0, yaRegistradas: 1 });
    });

    it('un historial largo se corta con aviso en vez de leer sin fin', async () => {
        const { service, meli } = await construir({ conexiones: [cuenta()] });
        meli.searchOrdersPage.mockImplementation(async (_t: string, _s: string, o: any) => ({
            results: Array.from({ length: 50 }, (_, i) => ordenMl(o.offset + i + 1)),
            total: 5000,
        }));

        const r = await service.importOrderHistory(SCOPE, 365);

        expect(r.cuentas[0].incompleto).toBe(true);
        expect(r.cuentas[0].registradas).toBeLessThanOrEqual(650);
    });

    it('Falabella: registra las ventas viejas sin tocar el stock y limita la fecha', async () => {
        const producto = { id: 'p1', sku: 'REL-01', name: 'Reloj', stock: 20 };
        const fal = cuenta({ id: 'fal1', marketplace: 'falabella', externalUserId: 'v@x.com', accessToken: 'k' });
        const { service, falabella, ventas, avisos } = await construir({ conexiones: [fal], productos: [producto] });
        falabella.getOrders.mockResolvedValueOnce([{ OrderId: 55, OrderNumber: '7000', Price: '100', CustomerFirstName: 'Ana', CustomerLastName: 'Ruiz', CreatedAt: '2026-08-01 10:00:00', Statuses: { Status: 'delivered' } }]);
        falabella.getOrderItems.mockResolvedValue([{ Sku: 'REL-01', Name: 'Reloj', PaidPrice: '100' }]);

        const r = await service.importOrderHistory(SCOPE, 60);

        expect(r.totalRegistradas).toBe(1);
        expect(ventas[0]).toMatchObject({ externalId: '55', customerName: 'Ana Ruiz', store: { id: 't1' } });
        expect(producto.stock).toBe(20);
        expect(avisos).toHaveLength(0);
        const opciones = falabella.getOrders.mock.calls[0][1];
        expect(MS(opciones.createdBefore)).toBeLessThan(Date.now() - 47 * 3_600_000);
        expect(MS(opciones.createdAfter)).toBeLessThan(MS(opciones.createdBefore));
    });

    it('una cuenta que falla no impide traer el historial de las demás', async () => {
        const rota = cuenta({ id: 'fal-rota', marketplace: 'falabella' });
        const buena = cuenta();
        const { service, falabella, meli } = await construir({ conexiones: [rota, buena] });
        falabella.getOrders.mockRejectedValue(new Error('sin permiso'));
        meli.searchOrdersPage.mockResolvedValue({ results: [ordenMl(1)], total: 1 });

        const r = await service.importOrderHistory(SCOPE, 90);

        expect(r.cuentas.find(c => c.id === 'fal-rota')?.error).toMatch(/sin permiso/);
        expect(r.totalRegistradas).toBe(1);
    });

    it('renueva el token vencido de Mercado Libre antes de pedir el historial', async () => {
        const vencida = cuenta({ expiresAt: new Date(Date.now() - 3600_000), refreshToken: 'r1' });
        const { service, meli } = await construir({ conexiones: [vencida] });
        meli.refreshTokens.mockResolvedValue({ accessToken: 'nuevo', refreshToken: 'r2', expiresIn: 21600 });
        meli.searchOrdersPage.mockResolvedValue({ results: [ordenMl(1)], total: 1 });

        const r = await service.importOrderHistory(SCOPE, 90);

        expect(meli.refreshTokens).toHaveBeenCalledWith('r1');
        expect(meli.searchOrdersPage.mock.calls[0][0]).toBe('nuevo');
        expect(r.totalRegistradas).toBe(1);
    });

    it('limita los días entre 1 y 365 y solo acepta cuentas de la tienda', async () => {
        const { service, meli } = await construir({ conexiones: [cuenta()] });

        const r = await service.importOrderHistory(SCOPE, 9999);
        expect(r.dias).toBe(365);
        expect((await service.importOrderHistory(SCOPE, 0)).dias).toBe(90); // 0 = valor por defecto
        await expect(service.importOrderHistory(SCOPE, 30, 'cuenta-de-otra-tienda')).rejects.toBeInstanceOf(NotFoundException);
        expect(meli.searchOrdersPage).toHaveBeenCalledTimes(2);
    });
});
