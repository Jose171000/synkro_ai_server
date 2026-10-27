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
import { SaleAlertsService } from './sale-alerts.service';
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
        if (v && typeof v === 'object' && '_type' in v) return v._type === 'isNull' ? actual == null : v._type === 'not' ? actual !== v._value : true;
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
    const cola = { add: jest.fn(async (n: string, d: any, o?: any) => { trabajos.push({ n, d, o }); }), upsertJobScheduler: jest.fn().mockResolvedValue(undefined) };

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
            { provide: SaleAlertsService, useValue: { notificar: jest.fn() } },
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

    describe('variaciones agrupadas', () => {
        const polo = () => ({
            id: 'MPE2', title: 'Polo Básico', status: 'active', price: 40, available_quantity: 9,
            pictures: [{ id: 'f1', secure_url: 'https://img/rojo.jpg' }, { id: 'f2', secure_url: 'https://img/azul.jpg' }],
            variations: [
                { id: 11, price: 40, available_quantity: 4, seller_custom_field: 'POLO-RJ', picture_ids: ['f1'], attribute_combinations: [{ name: 'Color', value_name: 'Rojo' }] },
                { id: 12, price: 40, available_quantity: 5, seller_custom_field: 'POLO-AZ', picture_ids: ['f2'], attribute_combinations: [{ name: 'Color', value_name: 'Azul' }] },
            ],
        });

        it('la vista previa cuenta el grupo con su eje y sus valores, sin crear nada', async () => {
            const { service, meli, productos } = await construir({ conexiones: [cuenta()] });
            meli.listSellerItemIds.mockResolvedValue({ ids: ['MPE2'], incompleto: false });
            meli.getItems.mockResolvedValue({ items: [polo()], notFound: [] });
            const aplicar = jest.fn();
            (service as any).variantImport = { aplicar };

            const r = await service.importMeliListings(SCOPE, undefined, { dryRun: true });

            expect(r.variantes.grupos).toBe(1);
            expect(r.variantes.variantes).toBe(2);
            expect(r.variantes.ejemplos[0]).toMatchObject({ parentSku: 'MPE2', nombre: 'Polo Básico', ejes: [{ name: 'Color', values: ['Rojo', 'Azul'] }] });
            expect(aplicar).not.toHaveBeenCalled();
            expect(productos).toHaveLength(0);
        });

        it('al importar, cada variante conserva su propia foto y se agrupan con los valores de Mercado Libre', async () => {
            const { service, meli, productos } = await construir({ conexiones: [cuenta()] });
            meli.listSellerItemIds.mockResolvedValue({ ids: ['MPE2'], incompleto: false });
            meli.getItems.mockResolvedValue({ items: [polo()], notFound: [] });
            const aplicar = jest.fn(async () => ({ gruposCreados: 1, gruposActualizados: 0, variantesAgrupadas: 2, omitidos: [] }));
            (service as any).variantImport = { aplicar };

            const r = await service.importMeliListings(SCOPE, undefined);

            expect(productos.map(p => [p.sku, p.images[0].url])).toEqual([['POLO-RJ', 'https://img/rojo.jpg'], ['POLO-AZ', 'https://img/azul.jpg']]);
            const [, grupos, porSku] = aplicar.mock.calls[0] as any[];
            expect(grupos[0].variants).toEqual([{ sellerSku: 'POLO-RJ', values: { Color: 'Rojo' } }, { sellerSku: 'POLO-AZ', values: { Color: 'Azul' } }]);
            expect([...porSku.keys()]).toEqual(['POLO-RJ', 'POLO-AZ']);
            expect(r.variantes.aplicado).toMatchObject({ gruposCreados: 1, variantesAgrupadas: 2 });
        });

        it('las publicaciones de una familia se agrupan por su atributo COLOR, cada una con su foto', async () => {
            const publicacion = (id: string, sku: string, color: string) => ({
                id, title: `Sábana Queen ${color}`, status: 'active', price: 180, available_quantity: 3, seller_custom_field: sku,
                family_id: '999', family_name: 'Sábana Queen', category_id: 'MPE7',
                pictures: [{ id: `f${id}`, secure_url: `https://img/${id}.jpg` }],
                attributes: [{ id: 'COLOR', name: 'Color', value_name: color }, { id: 'MATTRESS_SIZE', name: 'Tamaño', value_name: 'Queen' }],
            });
            const { service, meli, productos } = await construir({ conexiones: [cuenta()] });
            meli.listSellerItemIds.mockResolvedValue({ ids: ['M1', 'M2'], incompleto: false });
            meli.getItems.mockResolvedValue({ items: [publicacion('M1', 'SAB-BE__31166982', 'Beige y gris'), publicacion('M2', 'SAB-CR__31166975', 'Crema y marrón')], notFound: [] });
            const aplicar = jest.fn(async () => ({ gruposCreados: 1, gruposActualizados: 0, variantesAgrupadas: 2, omitidos: [] }));
            (service as any).variantImport = { aplicar };

            const r = await service.importMeliListings(SCOPE, undefined);

            expect(r.variantes.grupos).toBe(1);
            expect(r.variantes.ejemplos[0]).toMatchObject({ parentSku: 'FAM-999', nombre: 'Sábana Queen', ejes: [{ name: 'Color', values: ['Beige y gris', 'Crema y marrón'] }] });
            expect(productos.map((x) => [x.sku, x.images[0].url])).toEqual([['SAB-BE', 'https://img/M1.jpg'], ['SAB-CR', 'https://img/M2.jpg']]);
            const [, grupos, porSku] = aplicar.mock.calls[0] as any[];
            expect(grupos[0].variants.map((v: any) => v.sellerSku)).toEqual(['SAB-BE', 'SAB-CR']);
            expect([...porSku.keys()]).toEqual(['SAB-BE', 'SAB-CR']);
        });

        it('dos publicaciones con el mismo SKU: solo la principal se enlaza, la otra se informa como repetida y no pisa el enlace', async () => {
            const publicacion = (id: string, vendidas: number, precio: number) => ({
                id, title: 'Organizador Zapateras', status: 'active', price: precio, available_quantity: 10, seller_custom_field: 'ZPT-6',
                sold_quantity: vendidas, permalink: `https://ml/${id}`, pictures: [{ id: 'f', secure_url: `https://img/${id}.jpg` }],
            });
            const { service, meli, productos, enlaces } = await construir({ conexiones: [cuenta()] });
            meli.listSellerItemIds.mockResolvedValue({ ids: ['MPE1', 'MPE2'], incompleto: false });
            meli.getItems.mockResolvedValue({ items: [publicacion('MPE1', 0, 150), publicacion('MPE2', 7, 80)], notFound: [] });

            const r = await service.importMeliListings(SCOPE, undefined);

            expect(r.duplicadas).toBe(1);
            expect(r.total).toBe(1);
            expect(r.duplicados[0].publicaciones.map((x: any) => [x.externalId, x.principal])).toEqual([['MPE2', true], ['MPE1', false]]);
            expect(productos).toHaveLength(1);
            expect(enlaces).toHaveLength(1);
            expect(enlaces[0]).toMatchObject({ externalId: 'MPE2', regularPrice: 80 });
        });

        it('las familias que ya están agrupadas en Synkro no se vuelven a proponer', async () => {
            const publicacion = (id: string, sku: string, color: string) => ({
                id, title: `Sábana ${color}`, status: 'active', price: 180, available_quantity: 3, seller_custom_field: sku,
                family_id: '777', family_name: 'Sábana', category_id: 'MPE7', pictures: [],
                attributes: [{ id: 'COLOR', name: 'Color', value_name: color }],
            });
            const { service, meli, repoProductos } = await construir({ conexiones: [cuenta()] });
            meli.listSellerItemIds.mockResolvedValue({ ids: ['M1', 'M2'], incompleto: false });
            meli.getItems.mockResolvedValue({ items: [publicacion('M1', 'S-1', 'Rojo'), publicacion('M2', 'S-2', 'Azul')], notFound: [] });
            const qb: any = { select: () => qb, where: () => qb, andWhere: () => qb, getRawMany: async () => [{ sku: 'S-1' }, { sku: 'S-2' }] };
            (repoProductos as any).createQueryBuilder = jest.fn(() => qb);

            const r = await service.importMeliListings(SCOPE, undefined, { dryRun: true });

            expect(r.variantes.grupos).toBe(0);
            expect(r.variantes.yaAgrupadas).toBe(1);
        });

        it('una publicación sin variaciones no forma grupo', async () => {
            const { service, meli } = await construir({ conexiones: [cuenta()] });
            meli.listSellerItemIds.mockResolvedValue({ ids: ['MPE1'], incompleto: false });
            meli.getItems.mockResolvedValue({ items: [itemSimple()], notFound: [] });
            const aplicar = jest.fn();
            (service as any).variantImport = { aplicar };

            const r = await service.importMeliListings(SCOPE, undefined);

            expect(r.variantes.grupos).toBe(0);
            expect(aplicar).not.toHaveBeenCalled();
        });
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
        expect(meli.getShipment).toHaveBeenCalledTimes(2); // el envío da el nombre real y la dirección
    });

    it('completa con el envío las ventas del historial que se importaron sin él', async () => {
        const { service, meli, ventas } = await construir({ conexiones: [cuenta()] });
        meli.searchOrdersPage.mockResolvedValue({ results: [ordenMl(1, { buyer: { nickname: 'ME2025' } })], total: 1 });
        meli.getShipment.mockResolvedValueOnce(null); // primera vez: el envío no respondió
        await service.importOrderHistory(SCOPE, 90);
        expect(ventas[0].customerName).toBe('ME2025');
        expect(ventas[0].details.shipping.method).toBeNull();

        meli.getShipment.mockResolvedValue({ status: 'delivered', tracking_number: 'T1', receiver_address: { receiver_name: 'Rosa Quispe', address_line: 'Av. Lima 123' }, shipping_option: { name: 'Estándar' } });
        await service.importOrderHistory(SCOPE, 90);

        expect(ventas[0].customerName).toBe('Rosa Quispe');
        expect(ventas[0].details.shipping).toMatchObject({ method: 'Estándar', trackingCode: 'T1', address: { line: 'Av. Lima 123' } });
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

describe('publicar en Falabella lo que ya está allí', () => {
    const fal = (over: any = {}) => cuenta({ id: 'fa1', marketplace: 'falabella', externalUserId: 'seller', ...over });
    const listo = (over: any = {}) => ({
        id: 'p1', sku: 'MK-TOR-004', name: 'Torre', price: 480, stock: 50, description: 'Torre de madera para niños',
        packageWidth: 30, packageLength: 40, packageHeight: 20, packageWeight: 3,
        marketplaceIds: { falabella_category_id: '2804' }, aiAttributes: { brand: 'GENERICO' },
        store: { id: 't1' }, owner: { id: 'u1' }, ...over,
    });
    const preparar = async (producto: any, enlaces: any[] = []) => {
        const t = await construir({ conexiones: [fal()], productos: [producto], enlaces });
        t.falabella.brandsIndex = jest.fn().mockResolvedValue(new Map());
        t.falabella.getCategoryAttributes = jest.fn().mockResolvedValue([]);
        t.falabella.getProductsBySku = jest.fn().mockResolvedValue([]);
        t.falabella.productCreate = jest.fn().mockResolvedValue('feed-1');
        return t;
    };

    it('un producto ya publicado en esa cuenta no se vuelve a enviar', async () => {
        const p = listo();
        const { service, falabella } = await preparar(p, [{ id: 'e1', marketplace: 'falabella', syncStatus: 'published', product: p, connection: { id: 'fa1' } }]);

        const r: any = await service.publishBatchToFalabella(SCOPE, 'fa1', ['p1']);

        expect(r.enviados).toBe(0);
        expect(r.rechazados[0].motivo).toMatch(/ya está publicado/);
        expect(falabella.productCreate).not.toHaveBeenCalled();
    });

    it('si el SKU ya existe en Falabella se vincula como publicado en vez de reenviarlo', async () => {
        const p = listo();
        const { service, falabella, enlaces } = await preparar(p);
        falabella.getProductsBySku.mockResolvedValue([{ SellerSku: 'mk-tor-004' }]);

        const r: any = await service.publishBatchToFalabella(SCOPE, 'fa1', ['p1']);

        expect(r.enviados).toBe(0);
        expect(r.rechazados[0].motivo).toMatch(/ya existía/);
        expect(falabella.productCreate).not.toHaveBeenCalled();
        expect(enlaces).toEqual([expect.objectContaining({ marketplace: 'falabella', syncStatus: 'published', lastError: null })]);
    });

    it('un producto nuevo sí se envía', async () => {
        const p = listo();
        const { service, falabella } = await preparar(p);
        (service as any).feedRepository = { create: (x: any) => x, save: async (x: any) => ({ ...x, id: 'f1' }) };
        const r: any = await service.publishBatchToFalabella(SCOPE, 'fa1', ['p1']);
        expect(r.enviados).toBe(1);
        expect(falabella.productCreate).toHaveBeenCalledTimes(1);
    });
});

describe('atributos de Falabella: todos los que se conocen, con valores válidos', () => {
    const fal = () => cuenta({ id: 'fa1', marketplace: 'falabella', externalUserId: 'seller' });
    const producto = (attrs: any) => ({
        id: 'p1', sku: 'MK-1', name: 'Torre', price: 480, stock: 5, description: 'Torre de madera para niños',
        packageWidth: 30, packageLength: 40, packageHeight: 20, packageWeight: 3,
        marketplaceIds: { falabella_category_id: '956' }, aiAttributes: { brand: 'GENERICO', ...attrs },
        store: { id: 't1' }, owner: { id: 'u1' }, images: [],
    });
    const atributo = (name: string, over: any = {}) => ({ name, feedName: name.toUpperCase(), label: name, isMandatory: false, inputType: 'textField', options: [], description: '', ...over });

    it('envía también los opcionales con valor y deja fuera un valor que no está en la lista de opciones', async () => {
        const { service } = await construir({ conexiones: [fal()] });
        const attrs = [
            atributo('material', { isMandatory: true, options: ['Madera', 'Plástico'] }),
            atributo('color', { options: ['Azul', 'Rojo'] }),
            atributo('garantia', {}),
            atributo('tipo_de_bloques', { options: ['Encastre', 'Apilables'] }),
        ];
        const r: any = (service as any).toFalabellaInput(producto({ material: 'madera', color: 'azul', garantia: '12 meses', tipo_de_bloques: 'Inventado' }), 'active', attrs);

        expect(r.input.extraAttributes).toEqual({ MATERIAL: 'Madera', COLOR: 'Azul', GARANTIA: '12 meses' });
    });

    it('un obligatorio con un valor que no está en sus opciones no deja publicar y lo dice', async () => {
        const { service } = await construir({ conexiones: [fal()] });
        const r: any = (service as any).toFalabellaInput(producto({ material: 'Cartón' }), 'active', [atributo('material', { label: 'Material', isMandatory: true, options: ['Madera'] })]);
        expect(r.reason).toMatch(/Material \(valor no válido\)/);
    });

    it('el nombre para Falabella tiene 100 caracteres como máximo y no corta una palabra', async () => {
        const { service } = await construir({ conexiones: [fal()] });
        const largo = 'Torre de aprendizaje Montessori evolutiva 4 en 1 de madera de pino con escalones regulables y pizarra para niños pequeños';
        const n = (service as any).nombreParaFalabella(largo);
        expect(n.length).toBeLessThanOrEqual(100);
        expect(largo.startsWith(n)).toBe(true);
        expect(largo[n.length]).toBe(' ');
        expect((service as any).nombreParaFalabella('  Nombre   corto  ')).toBe('Nombre corto');
    });
});

describe('enviar solo los cambios de contenido a cada canal', () => {
    it('programa un envío por cuenta donde el producto está publicado, con un id fijo para juntar guardados seguidos', async () => {
        const p = { id: 'p1', sku: 'MK-1' };
        const { service, trabajos } = await construir({
            productos: [p],
            enlaces: [
                { id: 'e1', marketplace: 'falabella', syncStatus: 'published', product: p, connection: { id: 'fa1', status: 'active' } },
                { id: 'e2', marketplace: 'mercadolibre', syncStatus: 'published', product: p, connection: { id: 'ml1', status: 'active' } },
                { id: 'e3', marketplace: 'falabella', syncStatus: 'error', product: p, connection: { id: 'fa2', status: 'active' } },
                { id: 'e4', marketplace: 'woocommerce', syncStatus: 'published', product: p, connection: { id: 'wo1', status: 'active' } },
            ],
        });
        const r = await service.scheduleContentSync('p1', 1000);

        expect(r).toEqual([{ marketplace: 'falabella', connectionId: 'fa1' }, { marketplace: 'mercadolibre', connectionId: 'ml1' }]);
        expect(trabajos.map((t: any) => t.n)).toEqual(['content-update', 'content-update']);
        expect(trabajos[0].d).toMatchObject({ productId: 'p1', connectionId: 'fa1', marketplace: 'falabella' });
    });
});

describe('campos de sistema y atributos que Falabella dijo que no aplican', () => {
    const fal = () => cuenta({ id: 'fa1', marketplace: 'falabella', externalUserId: 'seller' });
    const base = (attrs: any) => ({
        id: 'p1', sku: 'MK-1', name: 'Torre', price: 480, stock: 5, description: 'Torre de madera para niños',
        packageWidth: 30, packageLength: 40, packageHeight: 20, packageWeight: 3,
        marketplaceIds: { falabella_category_id: '956' }, aiAttributes: { brand: 'GENERICO', ...attrs },
        store: { id: 't1' }, owner: { id: 'u1' }, images: [],
    });
    const atributo = (name: string) => ({ name, feedName: name.replace(/_(w)/g, (_m, c) => c.toUpperCase()), label: name, isMandatory: false, inputType: 'textField', options: [], description: '' });

    it('ParentSku, TaxClass y ShipmentType nunca se envían, aunque el producto tenga un valor guardado', async () => {
        const { service } = await construir({ conexiones: [fal()] });
        const r: any = (service as any).toFalabellaInput(
            base({ parent_sku: 'X', tax_class: 'IGV', shipment_type: 'dropshipping', garantia: '12 meses' }), 'active',
            [atributo('parent_sku'), atributo('tax_class'), atributo('shipment_type'), atributo('garantia')],
        );
        expect(Object.keys(r.input.extraAttributes)).toEqual(['garantia']);
    });

    it('un atributo que Falabella ya dijo que no aplica a la categoría se deja de enviar', async () => {
        const { service } = await construir({ conexiones: [fal()] });
        const r: any = (service as any).toFalabellaInput(
            base({ color: 'Azul', garantia: '12 meses', _noAplica: ['Color'] }), 'active',
            [atributo('color'), atributo('garantia')],
        );
        expect(r.input.extraAttributes).toEqual({ garantia: '12 meses' });
    });

    it('un atributo que Falabella exigió como no vacío se envía aunque antes se anotara que no aplica', async () => {
        const { service } = await construir({ conexiones: [fal()] });
        const r: any = (service as any).toFalabellaInput(
            base({ tamano_cama_variant: '2 plazas', _noAplica: ['tamano_cama_variant'], _obligatorios: ['TamanoCamaVariant'] }), 'active',
            [atributo('tamano_cama_variant')],
        );
        expect(Object.values(r.input.extraAttributes)).toEqual(['2 plazas']);
    });

    it('al guardar los datos de Falabella solo se reactiva lo que la persona cambió, no lo que sigue igual', async () => {
        const { service } = await construir({ conexiones: [fal()] });
        const prod: any = base({ garantia: '12 meses', tamano_cama_variant: 'vacío', _noAplica: ['garantia', 'tamano_cama_variant'] });
        prod.save = undefined;
        jest.spyOn(service as any, 'findScopedProduct').mockResolvedValue(prod);
        jest.spyOn(service as any, 'resolveConnection').mockRejectedValue(new Error('sin cuenta'));
        jest.spyOn(service as any, 'scheduleContentSync').mockResolvedValue([]);
        (service as any).productRepository = { save: jest.fn(async (p: any) => p) };
        await service.prepareFalabellaProduct({ userId: 'u1', storeId: 't1' } as any, 'p1', {
            categoryId: '956', packageWidth: 1, packageLength: 1, packageHeight: 1, packageWeight: 1,
            attributes: { garantia: '12 meses', tamano_cama_variant: '2 plazas' },
        });
        // «garantia» siguió igual y se mantiene como no aplica; «tamano_cama_variant» cambió y se vuelve a enviar.
        expect(prod.aiAttributes._noAplica).toEqual(['garantia']);
    });

    it('si es obligatorio por haberlo exigido Falabella y está vacío, lo pide antes de enviar', async () => {
        const { service } = await construir({ conexiones: [fal()] });
        const r: any = (service as any).toFalabellaInput(base({ _obligatorios: ['tamano_cama_variant'] }), 'active', [atributo('tamano_cama_variant')]);
        expect(r.reason).toMatch(/tamano_cama_variant/);
    });
});

describe('un segundo clic en Publicar mientras el canal todavía procesa', () => {
    const prod = { id: 'p1', sku: 'MK-1', price: 480, stock: 5, store: { id: 't1' }, owner: { id: 'u1' } };
    const fal = () => cuenta({ id: 'fa1', marketplace: 'falabella', externalUserId: 'seller' });

    it('no encola otro envío si el anterior sigue pendiente, y avisa', async () => {
        const { service, trabajos } = await construir({
            conexiones: [fal()], productos: [prod],
            enlaces: [{ id: 'e1', marketplace: 'falabella', syncStatus: 'pending', updatedAt: new Date(), product: prod, connection: { id: 'fa1' } }],
        });
        await expect(service.enqueuePublish(SCOPE, 'p1', ['falabella'], { falabella: 'fa1' })).rejects.toThrow(/ya se está publicando/);
        expect(trabajos).toHaveLength(0);
    });

    it('si lleva demasiado tiempo pendiente (más de 15 minutos) sí deja reintentar', async () => {
        const { service, trabajos } = await construir({
            conexiones: [fal()], productos: [prod],
            enlaces: [{ id: 'e1', marketplace: 'falabella', syncStatus: 'pending', updatedAt: new Date(Date.now() - 20 * 60_000), product: prod, connection: { id: 'fa1' } }],
        });
        await service.enqueuePublish(SCOPE, 'p1', ['falabella'], { falabella: 'fa1' });
        expect(trabajos.map((t: any) => t.n)).toEqual(['publish']);
    });

    it('un enlace con error o sin publicar se puede volver a enviar', async () => {
        const { service, trabajos } = await construir({
            conexiones: [fal()], productos: [prod],
            enlaces: [{ id: 'e1', marketplace: 'falabella', syncStatus: 'error', updatedAt: new Date(), product: prod, connection: { id: 'fa1' } }],
        });
        await service.enqueuePublish(SCOPE, 'p1', ['falabella'], { falabella: 'fa1' });
        expect(trabajos).toHaveLength(1);
    });
});

describe('preguntar a Falabella por un envío que sigue procesando', () => {
    const prod = { id: 'p1', sku: 'MK-1', stock: 5, price: 480 };
    async function preparar(estado: string) {
        const t = await construir({
            conexiones: [cuenta({ id: 'fa1', marketplace: 'falabella', externalUserId: 'seller' })],
            productos: [prod],
            enlaces: [{ id: 'e1', marketplace: 'falabella', syncStatus: 'pending', product: prod, connection: { id: 'fa1' } }],
        });
        const feed: any = { id: 'f1', externalFeedId: 'ext', action: 'ProductCreate', skus: ['MK-1'], connection: { id: 'fa1' }, status: 'pending' };
        (t.service as any).feedRepository = { findOne: jest.fn(async () => feed), save: jest.fn(async (x: any) => x) };
        t.falabella.getFeedStatus = jest.fn(async () => ({ feedId: 'ext', status: estado, action: 'ProductCreate', totalRecords: 1, processedRecords: 0, failedRecords: 0, errors: [] }));
        return { ...t, feed };
    }

    it('con cada intento espera más: 1 minuto al principio, 3 después y 10 al final', async () => {
        const { service, trabajos } = await preparar('Processing');
        await service.checkFalabellaFeed('f1', 'u1', 0);
        await service.checkFalabellaFeed('f1', 'u1', 6);
        await service.checkFalabellaFeed('f1', 'u1', 20);
        expect(trabajos.map((t: any) => t.d.intento)).toEqual([1, 7, 21]);
    });

    it('al llegar al máximo deja de preguntar, marca el producto con error y avisa', async () => {
        const { service, trabajos, enlaces, feed } = await preparar('Processing');
        const r = await service.checkFalabellaFeed('f1', 'u1', 30);

        expect(r.status).toBe('timeout');
        expect(trabajos).toHaveLength(0);
        expect(feed.status).toBe('timeout');
        expect(enlaces[0]).toMatchObject({ syncStatus: 'error', lastError: expect.stringContaining('no terminó de procesar') });
    });
});

describe('si falla la comprobación de un envío a Falabella', () => {
    it('se reprograma en vez de dejar el producto en «Publicando…», y tras el máximo se rinde avisando', async () => {
        const { service, trabajos, avisos } = await construir({});
        (service as any).feedRepository = { findOne: jest.fn(async () => ({ id: 'f1', status: 'pending' })), save: jest.fn(async (x: any) => x) };

        const r1 = await service.reintentarRevisionDeFeed('f1', 'u1', 2, 'timeout de red');
        expect(r1.status).toBe('reintento');
        expect(trabajos[0]).toMatchObject({ n: 'falabella-feed', d: { feedRecordId: 'f1', intento: 3 } });

        const r2 = await service.reintentarRevisionDeFeed('f1', 'u1', 30, 'timeout de red');
        expect(r2.status).toBe('timeout');
        expect(trabajos).toHaveLength(1);
        expect(avisos[0]).toMatchObject({ type: 'publish-error', title: expect.stringContaining('No se pudo comprobar') });
    });
});

describe('varias publicaciones a la vez en Falabella', () => {
    const prod = { id: 'p1', sku: 'MK-1', price: 480, stock: 5, store: { id: 't1' }, owner: { id: 'u1' } };
    const fal = () => cuenta({ id: 'fa1', marketplace: 'falabella', externalUserId: 'seller' });

    it('el envío a Falabella se reintenta (5 veces, con espera creciente) y el de Mercado Libre no', async () => {
        const { service, trabajos } = await construir({ conexiones: [fal(), cuenta()], productos: [prod] });
        await service.enqueuePublish(SCOPE, 'p1', ['falabella'], { falabella: 'fa1' });
        await service.enqueuePublish(SCOPE, 'p1', ['mercadolibre'], { mercadolibre: 'ml1' });

        expect(trabajos[0].o).toEqual({ attempts: 5, backoff: { type: 'exponential', delay: 120_000 } });
        expect(trabajos[1].o).toBeUndefined();
    });

    it('un envío que no pudo salir queda con error y su motivo, y avisa; no desaparece sin rastro', async () => {
        const { service, enlaces, avisos } = await construir({ conexiones: [fal()], productos: [prod] });
        await service.marcarPublicacionFallida('p1', 'fa1', 'u1', 'Falabella rechazó la petición ProductCreate: E429 Too many requests');

        expect(enlaces[0]).toMatchObject({ marketplace: 'falabella', syncStatus: 'error', lastError: expect.stringContaining('Too many requests') });
        expect(avisos[0]).toMatchObject({ type: 'publish-error', title: expect.stringContaining('MK-1') });
    });

    it('si el producto ya estaba publicado, un envío repetido que falla no lo pone en error', async () => {
        const { service, enlaces } = await construir({
            conexiones: [fal()], productos: [prod],
            enlaces: [{ id: 'e1', marketplace: 'falabella', syncStatus: 'published', product: prod, connection: { id: 'fa1' } }],
        });
        await service.marcarPublicacionFallida('p1', 'fa1', 'u1', 'lo que sea');
        expect(enlaces[0].syncStatus).toBe('published');
    });
});

describe('avisos de Falabella: envíos terminados y cambios de calidad', () => {
    const prod = { id: 'p1', sku: 'MK-1', stock: 5, price: 480 };
    const cuentaFal = () => cuenta({ id: 'fa1', marketplace: 'falabella', externalUserId: 'seller', secrets: { webhookToken: 'tok-1' } });

    async function preparar(enlaceEstado = 'pending') {
        const t = await construir({
            conexiones: [cuentaFal()], productos: [prod],
            enlaces: [{ id: 'e1', marketplace: 'falabella', syncStatus: enlaceEstado, product: prod, connection: { id: 'fa1', owner: { id: 'u1' } } }],
        });
        return t;
    }

    it('un aviso de envío terminado programa la comprobación de ese envío al instante', async () => {
        const { service, trabajos } = await preparar();
        (service as any).feedRepository = { findOne: jest.fn(async () => ({ id: 'f1', externalFeedId: 'ext-9' })) };
        await service.handleFalabellaNotification('tok-1', { event: 'onFeedCompleted', payload: { FeedId: 'ext-9' } });
        expect(trabajos[0]).toMatchObject({ n: 'falabella-feed', d: { feedRecordId: 'f1', intento: 0 } });
    });

    it('un aviso de calidad programa la lectura del estado de ese SKU; uno de ventas sigue yendo a los pedidos', async () => {
        const { service, trabajos } = await preparar();
        await service.handleFalabellaNotification('tok-1', { event: 'onProductQcStatusChanged', payload: { SellerSku: 'MK-1' } });
        await service.handleFalabellaNotification('tok-1', { event: 'onOrderCreated', payload: { OrderId: '55' } });
        expect(trabajos[0]).toMatchObject({ n: 'falabella-qc', d: { connectionId: 'fa1', skus: ['MK-1'] } });
        expect(trabajos[1]).toMatchObject({ n: 'falabella-order' });
    });

    it('un testigo desconocido se ignora sin encolar nada', async () => {
        const { service, trabajos } = await preparar();
        await service.handleFalabellaNotification('otro', { event: 'onFeedCompleted', payload: { FeedId: 'x' } });
        expect(trabajos).toHaveLength(0);
    });

    it('calidad aprobada → publicada y avisa; rechazada → error con el motivo de Falabella', async () => {
        const aprobada = await preparar('pending');
        aprobada.falabella.getQcStates = jest.fn(async () => [{ sku: 'MK-1', status: 'approved', reason: '' }]);
        const r1 = await aprobada.service.refreshFalabellaQc('fa1', ['MK-1']);
        expect(r1).toEqual({ aprobadas: 1, rechazadas: 0 });
        expect(aprobada.enlaces[0]).toMatchObject({ syncStatus: 'published', lastError: null });
        expect(aprobada.avisos[0]).toMatchObject({ type: 'publish', title: expect.stringContaining('aprobó') });

        const rechazada = await preparar('published');
        rechazada.falabella.getQcStates = jest.fn(async () => [{ sku: 'MK-1', status: 'rejected', reason: 'Automatically rejected: Images Missing' }]);
        const r2 = await rechazada.service.refreshFalabellaQc('fa1', ['MK-1']);
        expect(r2).toEqual({ aprobadas: 0, rechazadas: 1 });
        expect(rechazada.enlaces[0]).toMatchObject({ syncStatus: 'error', lastError: expect.stringContaining('Images Missing') });
        expect(rechazada.avisos[0]).toMatchObject({ type: 'publish-error' });
    });

    it('«Images Missing» justo tras crear la ficha (aún sin fecha de envío terminado) es pasajero: sigue en proceso y se vuelve a mirar', async () => {
        const reciente = await construir({
            conexiones: [cuentaFal()], productos: [prod],
            enlaces: [{ id: 'e1', marketplace: 'falabella', syncStatus: 'pending', lastSyncedAt: null, updatedAt: new Date(), product: prod, connection: { id: 'fa1', owner: { id: 'u1' } } }],
        });
        reciente.falabella.getQcStates = jest.fn(async () => [{ sku: 'MK-1', status: 'rejected', reason: 'Automatically rejected: Images Missing' }]);
        await reciente.service.refreshFalabellaQc('fa1', ['MK-1']);
        expect(reciente.enlaces[0].syncStatus).toBe('pending');
        expect(reciente.trabajos.find((x: any) => x.n === 'falabella-qc')).toBeTruthy();

        const vieja = await construir({
            conexiones: [cuentaFal()], productos: [prod],
            enlaces: [{ id: 'e1', marketplace: 'falabella', syncStatus: 'error', lastSyncedAt: null, updatedAt: new Date(Date.now() - 3 * 3600_000), product: prod, connection: { id: 'fa1', owner: { id: 'u1' } } }],
        });
        vieja.falabella.getQcStates = jest.fn(async () => [{ sku: 'MK-1', status: 'rejected', reason: 'Automatically rejected: Images Missing' }]);
        await vieja.service.refreshFalabellaQc('fa1', ['MK-1']);
        expect(vieja.enlaces[0].syncStatus).toBe('error');

        // Tras el máximo de revisiones deja de reprogramarse y queda como un rechazo normal.
        const agotada = await construir({
            conexiones: [cuentaFal()], productos: [prod],
            enlaces: [{ id: 'e1', marketplace: 'falabella', syncStatus: 'pending', lastSyncedAt: null, updatedAt: new Date(), product: prod, connection: { id: 'fa1', owner: { id: 'u1' } } }],
        });
        agotada.falabella.getQcStates = jest.fn(async () => [{ sku: 'MK-1', status: 'rejected', reason: 'Automatically rejected: Images Missing' }]);
        await agotada.service.refreshFalabellaQc('fa1', ['MK-1'], 10);
        expect(agotada.trabajos.find((x: any) => x.n === 'falabella-qc')).toBeUndefined();
        expect(agotada.enlaces[0].syncStatus).toBe('error');
    });

    it('la revisión pendiente de fotos lleva un identificador por SKU y ventana, para que las cadenas repetidas se junten en una', async () => {
        const t = await construir({
            conexiones: [cuentaFal()], productos: [prod],
            enlaces: [{ id: 'e1', marketplace: 'falabella', syncStatus: 'pending', lastSyncedAt: null, updatedAt: new Date(), product: prod, connection: { id: 'fa1', owner: { id: 'u1' } } }],
        });
        t.falabella.getQcStates = jest.fn(async () => [{ sku: 'MK-1', status: 'rejected', reason: 'Automatically rejected: Images Missing' }]);
        const espia = jest.spyOn((t.service as any).syncQueue, 'add');
        await t.service.refreshFalabellaQc('fa1', ['MK-1'], 2);
        const [nombre, datos, opciones] = espia.mock.calls.find((c: any) => c[0] === 'falabella-qc') as any;
        expect(nombre).toBe('falabella-qc');
        expect(datos).toMatchObject({ connectionId: 'fa1', skus: ['MK-1'], intento: 3 });
        expect(opciones.jobId).toMatch(/^qc-fotos-fa1-MK-1-\d+$/);
    });

    it('un rechazo por reglas de otra categoría descarta la categoría y no se vuelve a proponer', async () => {
        const conCategoria: any = { ...prod, marketplaceIds: { falabella_category_id: '77' }, aiAttributes: { brand: 'GENERICO', _categoriaVerificada: '77' } };
        const t = await construir({
            conexiones: [cuentaFal()], productos: [conCategoria],
            enlaces: [{ id: 'e1', marketplace: 'falabella', syncStatus: 'pending', product: conCategoria, connection: { id: 'fa1', owner: { id: 'u1' } } }],
        });
        t.falabella.getQcStates = jest.fn(async () => [{ sku: 'MK-1', status: 'rejected', reason: 'El Peso (kg) debe estar entre 9 kg y 27 kg para esta categoría' }]);
        await t.service.refreshFalabellaQc('fa1', ['MK-1']);
        expect(conCategoria.marketplaceIds.falabella_category_id).toBeUndefined();
        expect(conCategoria.aiAttributes._categoriasMalas.falabella).toEqual(['77']);
        expect(conCategoria.aiAttributes._categoriaDudosa).toBeTruthy();
        expect(t.enlaces[0].lastError).toMatch(/Seller Center/);
    });

    it('una ficha aprobada confirma su categoría una sola vez y quita la duda', async () => {
        const conCategoria: any = { ...prod, marketplaceIds: { falabella_category_id: '77' }, aiAttributes: { _categoriaDudosa: { id: '77', motivo: 'revisa' } } };
        const t = await construir({
            conexiones: [cuentaFal()], productos: [conCategoria],
            enlaces: [{ id: 'e1', marketplace: 'falabella', syncStatus: 'pending', product: conCategoria, connection: { id: 'fa1', owner: { id: 'u1' } } }],
        });
        const aprende = jest.fn(async () => undefined);
        (t.service as any).alAprobarseUnaFicha = aprende;
        t.falabella.getQcStates = jest.fn(async () => [{ sku: 'MK-1', status: 'approved', reason: '' }]);
        await t.service.refreshFalabellaQc('fa1', ['MK-1']);
        await t.service.refreshFalabellaQc('fa1', ['MK-1']);
        expect(aprende).toHaveBeenCalledTimes(1);
        expect(conCategoria.aiAttributes._categoriaDudosa).toBeUndefined();
    });

    it('sin SKU en el aviso revisa las fichas que esperan o fallaron, y no toca las ya publicadas', async () => {
        const { service, falabella } = await preparar('published');
        falabella.getQcStates = jest.fn(async () => []);
        const r = await service.refreshFalabellaQc('fa1', []);
        expect(r).toEqual({ aprobadas: 0, rechazadas: 0 });
        expect(falabella.getQcStates).not.toHaveBeenCalled();
    });
});

describe('formato real de los avisos de Falabella y envío procesado una sola vez', () => {
    const prod = { id: 'p1', sku: 'MK-1', stock: 5, price: 480, images: [{ url: 'https://i/1.jpg' }] };

    it('el aviso de calidad trae una lista de SKUs (SellerSkus)', async () => {
        const { service, trabajos } = await construir({
            conexiones: [cuenta({ id: 'fa1', marketplace: 'falabella', externalUserId: 'seller', secrets: { webhookToken: 'tok-1' } })],
        });
        await service.handleFalabellaNotification('tok-1', { event: 'onProductQcStatusChanged', payload: { SellerSkus: ['MK-TOR-004', 'MK-TOR-005'] } });
        expect(trabajos[0]).toMatchObject({ n: 'falabella-qc', d: { connectionId: 'fa1', skus: ['MK-TOR-004', 'MK-TOR-005'] } });
    });

    it('con las fotos fuera del alta (FALABELLA_IMAGES_IN_CREATE=0): el aviso trae {Feed} y la consulta periódica llegando a la vez no manda las fotos dos veces', async () => {
        process.env.FALABELLA_IMAGES_IN_CREATE = '0';
        const t = await construir({
            conexiones: [cuenta({ id: 'fa1', marketplace: 'falabella', externalUserId: 'seller', secrets: { webhookToken: 'tok-1' } })],
            productos: [prod],
            enlaces: [{ id: 'e1', marketplace: 'falabella', syncStatus: 'pending', product: prod, connection: { id: 'fa1' } }],
        });
        const feed: any = { id: 'f1', externalFeedId: 'ext-1', action: 'ProductCreate', skus: ['MK-1'], connection: { id: 'fa1' }, status: 'pending' };
        (t.service as any).feedRepository = { findOne: jest.fn(async () => feed), save: jest.fn(async (x: any) => ({ ...x, id: x.id ?? 'img-1' })), create: (x: any) => x };
        t.falabella.getFeedStatus = jest.fn(async () => ({ feedId: 'ext-1', status: 'Finished', action: 'ProductCreate', totalRecords: 1, processedRecords: 1, failedRecords: 0, errors: [] }));
        t.falabella.setImages = jest.fn(async () => 'feed-fotos');

        await t.service.handleFalabellaNotification('tok-1', { event: 'onFeedCompleted', payload: { Feed: 'ext-1' } });
        expect(t.trabajos[0]).toMatchObject({ n: 'falabella-feed', d: { feedRecordId: 'f1', intento: 0 } });

        // la consulta periódica y el aviso revisan el mismo envío casi al mismo tiempo
        await Promise.all([t.service.checkFalabellaFeed('f1', 'u1', 0), t.service.checkFalabellaFeed('f1', 'u1', 0)]);

        expect(t.falabella.setImages).toHaveBeenCalledTimes(1);
        expect(t.enlaces[0].syncStatus).toBe('published');
        delete process.env.FALABELLA_IMAGES_IN_CREATE;
    });

    it('con las fotos dentro del alta (lo normal) no sale un segundo envío de fotos', async () => {
        const t = await construir({
            conexiones: [cuenta({ id: 'fa1', marketplace: 'falabella', externalUserId: 'seller', secrets: { webhookToken: 'tok-1' } })],
            productos: [prod],
            enlaces: [{ id: 'e1', marketplace: 'falabella', syncStatus: 'pending', product: prod, connection: { id: 'fa1' } }],
        });
        const feed: any = { id: 'f1', externalFeedId: 'ext-1', action: 'ProductCreate', skus: ['MK-1'], connection: { id: 'fa1' }, status: 'pending' };
        (t.service as any).feedRepository = { findOne: jest.fn(async () => feed), save: jest.fn(async (x: any) => ({ ...x, id: x.id ?? 'img-1' })), create: (x: any) => x };
        t.falabella.getFeedStatus = jest.fn(async () => ({ feedId: 'ext-1', status: 'Finished', action: 'ProductCreate', totalRecords: 1, processedRecords: 1, failedRecords: 0, errors: [] }));
        t.falabella.setImages = jest.fn(async () => 'feed-fotos');
        await t.service.checkFalabellaFeed('f1', 'u1', 0);
        expect(t.falabella.setImages).not.toHaveBeenCalled();
        expect(t.enlaces[0].syncStatus).toBe('published');
    });

    it('si Falabella igual dice «Images Missing», las fotos se mandan aparte, una sola vez', async () => {
        const conFotos: any = { ...prod, aiAttributes: {} };
        const t = await construir({
            conexiones: [cuenta({ id: 'fa1', marketplace: 'falabella', externalUserId: 'seller', secrets: { webhookToken: 'tok-1' } })],
            productos: [conFotos],
            enlaces: [{ id: 'e1', marketplace: 'falabella', syncStatus: 'pending', updatedAt: new Date(), product: conFotos, connection: { id: 'fa1', owner: { id: 'u1' } } }],
        });
        (t.service as any).feedRepository = { save: jest.fn(async (x: any) => ({ ...x, id: 'img-1' })), create: (x: any) => x };
        t.falabella.getQcStates = jest.fn(async () => [{ sku: 'MK-1', status: 'rejected', reason: 'Automatically rejected: Images Missing' }]);
        t.falabella.setImages = jest.fn(async () => 'feed-fotos');
        await t.service.refreshFalabellaQc('fa1', ['MK-1']);
        await t.service.refreshFalabellaQc('fa1', ['MK-1']);
        expect(t.falabella.setImages).toHaveBeenCalledTimes(1);
    });
});

describe('publicaciones pausadas o retiradas desde Synkro', () => {
    it('una publicación pausada por el usuario no recibe stock ni precio (no se reactiva sola)', async () => {
        const producto = { id: 'p1', sku: 'REL-01', stock: 6, price: 45 };
        const { service, meli } = await construir({
            conexiones: [cuenta()], productos: [producto],
            enlaces: [{ id: 'e1', marketplace: 'mercadolibre', externalId: 'MPE1', variationId: null, syncStatus: 'paused', pausedByUser: true, product: producto, connection: { id: 'ml1' } }],
        });

        await service.pushInventoryToMeli('p1', 'ml1');

        expect(meli.updateItem).not.toHaveBeenCalled();
    });

    it('Falabella: una ficha pausada con stock 0 sigue pausada aunque el canal la muestre activa', async () => {
        const fal = cuenta({ id: 'fal1', marketplace: 'falabella', externalUserId: 'v@x.com' });
        const producto = { id: 'p1', sku: 'REL-01', stock: 6, price: 45 };
        const { service, falabella, enlaces } = await construir({
            conexiones: [fal], productos: [producto],
            enlaces: [{ id: 'e1', marketplace: 'falabella', externalId: 'SHOP-1', syncStatus: 'paused', pausedByUser: true, product: producto, connection: { id: 'fal1' } }],
        });
        falabella.getAllProducts.mockResolvedValue({
            productos: [{ SellerSku: 'REL-01', QCStatus: 'approved', BusinessUnits: { BusinessUnit: { Price: '45', Stock: '0', Status: 'active', IsPublished: '1' } } }],
            incompleto: false,
        });

        await service.refreshFalabellaLinks('fal1');

        expect(enlaces[0]).toMatchObject({ syncStatus: 'paused', pausedByUser: true, lastStockSynced: 0 });
    });

    it('Mercado Libre: si el canal la muestra activa, alguien la reactivó allí y deja de figurar pausada por el usuario', async () => {
        const producto = { id: 'p1', sku: 'REL-01', stock: 6, price: 45 };
        const { service, meli, enlaces } = await construir({
            conexiones: [cuenta()], productos: [producto],
            enlaces: [{ id: 'e1', marketplace: 'mercadolibre', externalId: 'MPE1', variationId: null, syncStatus: 'paused', pausedByUser: true, product: producto, connection: { id: 'ml1' } }],
        });
        meli.getItems.mockResolvedValue({ items: [{ id: 'MPE1', title: 'x', status: 'active', price: 45, available_quantity: 6, seller_custom_field: 'REL-01', pictures: [], variations: [] }], notFound: [] });

        await service.refreshMeliLinks('ml1');

        expect(enlaces[0]).toMatchObject({ syncStatus: 'published', pausedByUser: false });
    });

    it('una publicación retirada a propósito no se vuelve a enlazar al importar el canal', async () => {
        const fal = cuenta({ id: 'fal1', marketplace: 'falabella', externalUserId: 'v@x.com' });
        const producto = { id: 'p1', sku: 'REL-01', name: 'Rel', stock: 6, price: 45 };
        const { service, falabella, enlaces } = await construir({
            conexiones: [fal], productos: [producto],
            enlaces: [{ id: 'e1', marketplace: 'falabella', externalId: 'SHOP-1', syncStatus: 'removed', product: producto, connection: { id: 'fal1' } }],
        });
        falabella.getAllProducts.mockResolvedValue({
            productos: [{ SellerSku: 'REL-01', ShopSku: 'SHOP-1', Name: 'Rel', QCStatus: 'approved', BusinessUnits: { BusinessUnit: { Price: '45', Stock: '6', Status: 'active', IsPublished: '1' } } }],
            incompleto: false,
        });

        await service.refreshFalabellaLinks('fal1');

        expect(enlaces[0].syncStatus).toBe('removed');
    });
});

describe('Falabella: campos numéricos y errores múltiples', () => {
    const fal = () => cuenta({ id: 'fa1', marketplace: 'falabella', externalUserId: 'seller' });
    const base = (attrs: any) => ({
        id: 'p1', sku: 'MK-1', name: 'Sábanas', price: 250, stock: 5, description: 'Juego de sábanas de algodón',
        packageWidth: 30, packageLength: 40, packageHeight: 20, packageWeight: 3,
        marketplaceIds: { falabella_category_id: '1272' }, aiAttributes: { brand: 'GENERICO', ...attrs },
        store: { id: 't1' }, owner: { id: 'u1' }, images: [],
    });

    it('un campo numberfield se envía solo con el número', async () => {
        const { service } = await construir({ conexiones: [fal()] });
        const attr = { name: 'numero_de_hilos', feedName: 'NumeroDeHilos', label: 'Número de hilos', isMandatory: true, inputType: 'numberfield', options: [], description: '' };
        const r: any = (service as any).toFalabellaInput(base({ numero_de_hilos: '3000 hilos' }), 'active', [attr]);
        expect(r.input.extraAttributes).toEqual({ NumeroDeHilos: '3000' });
    });

    it('un campo numérico obligatorio sin ningún número no deja publicar', async () => {
        const { service } = await construir({ conexiones: [fal()] });
        const attr = { name: 'numero_de_hilos', feedName: 'NumeroDeHilos', label: 'Número de hilos', isMandatory: true, inputType: 'numberfield', options: [], description: '' };
        const r: any = (service as any).toFalabellaInput(base({ numero_de_hilos: 'muchos' }), 'active', [attr]);
        expect(r.reason).toMatch(/Número de hilos/);
    });
});
