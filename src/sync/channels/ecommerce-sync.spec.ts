import { BadRequestException } from '@nestjs/common';
import { EcommerceSyncService } from './ecommerce-sync.service';
import { ChannelListingRow, ChannelOrder } from './channel-types';

/**
 * Lógica común de WooCommerce y Shopify. Lo que se protege: se enlaza por SKU
 * sin pisar el stock ni el precio de lo que ya existe, la revisión periódica
 * solo toca el espejo del canal, una venta descuenta el stock y avisa a los
 * demás canales una sola vez, y el historial no mueve el stock.
 */

// ── Repositorios en memoria ──
function coincide(entidad: any, donde: any): boolean {
    if (Array.isArray(donde)) return donde.some(d => coincide(entidad, d));
    return Object.entries(donde ?? {}).every(([k, v]: [string, any]) => {
        const actual = entidad?.[k];
        if (v && typeof v === 'object' && '_type' in v) return v._type === 'isNull' ? actual == null : true;
        if (v && typeof v === 'object' && !(v instanceof Date)) return actual != null && coincide(actual, v);
        return actual === v;
    });
}
function repoEnMemoria(tabla: any[], prefijo: string) {
    return {
        findOne: jest.fn(async ({ where }: any) => tabla.find(x => coincide(x, where)) ?? null),
        find: jest.fn(async ({ where }: any = {}) => tabla.filter(x => coincide(x, where ?? {}))),
        create: jest.fn((d: any) => ({ ...d })),
        save: jest.fn(async (e: any) => {
            if (!e.id) { e.id = `${prefijo}-${tabla.length + 1}`; tabla.push(e); }
            else if (!tabla.includes(e)) { const i = tabla.findIndex(x => x.id === e.id); if (i >= 0) tabla[i] = e; else tabla.push(e); }
            return e;
        }),
        update: jest.fn(async (id: string, datos: any) => { Object.assign(tabla.find(x => x.id === id) ?? {}, datos); }),
    };
}

const SCOPE = { userId: 'u1', storeId: 't1' };
const cuenta = (over: any = {}) => ({
    id: 'wc1', marketplace: 'woocommerce', externalUserId: 'mitienda.com', externalNickname: 'mitienda.com',
    accessToken: 'ck_1', status: 'active', currency: 'PEN', secrets: { siteUrl: 'https://mitienda.com', consumerSecret: 'cs_1' },
    owner: { id: 'u1' }, store: { id: 't1' }, ...over,
});
const fila = (over: Partial<ChannelListingRow> = {}): ChannelListingRow => ({
    sku: 'REL-01', externalId: '10', variationId: null, title: 'Reloj', variation: null, regularPrice: 90, salePrice: null,
    stock: 7, status: 'published', permalink: 'https://mitienda.com/reloj', imageUrl: 'https://img/a.jpg',
    images: ['https://img/a.jpg'], currency: 'PEN', ...over,
});
const venta = (over: Partial<ChannelOrder> = {}, lineas: any[] = [{ sku: 'REL-01', title: 'Reloj', quantity: 2, unitPrice: 45 }]): ChannelOrder => ({
    externalId: '501', paid: true, channelStatus: 'processing', totalAmount: 90, currency: 'PEN', orderDate: new Date('2026-10-09T12:00:00Z'),
    normalized: {
        orderNumber: '501', customerName: 'Ana Ruiz', shipByDate: null, lines: lineas,
        details: { customer: { name: 'Ana Ruiz', email: null, phone: null, document: null }, shipping: { method: null, status: null, trackingCode: null, carrier: null, shipBy: null, deliveryBy: null, address: { line: null, city: null, region: null, country: null, postalCode: null, receiver: null, notes: null } }, payment: { method: null, status: null, paidAmount: 90, installments: null, approvedAt: null }, notes: null, channelStatus: 'processing' },
    },
    ...over,
});

function construir(over: { conexiones?: any[]; productos?: any[]; enlaces?: any[]; variantImport?: any } = {}) {
    const conexiones = over.conexiones ?? [];
    const productos = over.productos ?? [];
    const enlaces = over.enlaces ?? [];
    const ventas: any[] = [];
    const avisos: any[] = [];
    const claves = new Set<string>();

    const cliente: any = {
        channel: 'woocommerce',
        verify: jest.fn().mockResolvedValue({ accountId: 'mitienda.com', nickname: 'mitienda.com', currency: 'PEN' }),
        listListings: jest.fn().mockResolvedValue({ rows: [], sinSku: 0, productos: 0, incompleto: false }),
        fotosDeProductos: jest.fn().mockResolvedValue(new Map()),
        setInventory: jest.fn().mockResolvedValue(undefined),
        listOrders: jest.fn().mockResolvedValue({ orders: [], incompleto: false }),
    };
    const sync: any = {
        registerChannel: jest.fn(),
        resolveConnection: jest.fn(async () => conexiones[0]),
        getValidConnectionById: jest.fn(async (id: string) => conexiones.find(c => c.id === id)),
        findOrCreateConnection: jest.fn(async (_s: any, marketplace: string, externalUserId: string) =>
            conexiones.find(c => c.marketplace === marketplace && c.externalUserId === externalUserId) ?? { marketplace, externalUserId, owner: { id: 'u1' }, store: { id: 't1' } }),
        saveConnection: jest.fn(async (_s: any, c: any) => { if (!c.id) { c.id = 'nueva'; conexiones.push(c); } return c; }),
        findProductBySku: jest.fn(async (_s: any, sku: string) => {
            const p = productos.find(x => x.sku === sku);
            if (!p) return { product: null, otraTienda: false };
            return p.store && p.store.id !== 't1' ? { product: null, otraTienda: true } : { product: p, otraTienda: false };
        }),
        propagateStock: jest.fn().mockResolvedValue(undefined),
        reponerStockDeVenta: jest.fn().mockResolvedValue(undefined),
    };
    const repoProductos = repoEnMemoria(productos, 'prod');
    const repoEnlaces = repoEnMemoria(enlaces, 'enl');
    const repoVentas = repoEnMemoria(ventas, 'venta');
    const redis: any = { set: jest.fn(async (k: string) => { if (claves.has(k)) return null; claves.add(k); return 'OK'; }), del: jest.fn(async (k: string) => { claves.delete(k); }) };
    const notificaciones: any = { notify: jest.fn(async (u: string, a: any) => { avisos.push({ u, ...a }); }) };

    const alertas: any = { notificar: jest.fn(async () => undefined) };
    const service = new EcommerceSyncService(
        sync, {} as any, repoEnlaces as any, repoVentas as any, repoProductos as any, redis, notificaciones, alertas,
        cliente, cliente, cliente, over.variantImport,
    );
    return { service, cliente, sync, productos, enlaces, ventas, avisos, conexiones, repoProductos };
}

describe('conectar una tienda', () => {
    it('guarda la clave y, en WooCommerce, el secret y la dirección cifrados en secrets', async () => {
        const { service, conexiones, cliente } = construir();
        const r = await service.connect(SCOPE, 'woocommerce', { site: 'mitienda.com', token: ' ck_1 ', secret: ' cs_1 ', label: 'Web' });

        expect(cliente.verify).toHaveBeenCalledWith({ site: 'mitienda.com', token: 'ck_1', secret: 'cs_1' });
        expect(r).toMatchObject({ id: 'nueva', marketplace: 'woocommerce', nickname: 'mitienda.com', currency: 'PEN' });
        expect(conexiones[0]).toMatchObject({
            externalUserId: 'mitienda.com', accessToken: 'ck_1', status: 'active', currency: 'PEN',
            secrets: { siteUrl: 'https://mitienda.com', consumerSecret: 'cs_1' },
        });
    });

    it('en Shopify no guarda secrets y el token va en accessToken', async () => {
        const { service, conexiones, cliente } = construir();
        cliente.verify.mockResolvedValue({ accountId: 'mitienda.myshopify.com', nickname: 'Mi Tienda', currency: 'USD' });
        await service.connect(SCOPE, 'shopify', { site: 'mitienda', token: 'shpat_1' });

        expect(conexiones[0]).toMatchObject({ externalUserId: 'mitienda.myshopify.com', accessToken: 'shpat_1', secrets: null, currency: 'USD' });
    });

    it('si las claves no sirven no se guarda nada', async () => {
        const { service, conexiones, cliente } = construir();
        cliente.verify.mockRejectedValue(new BadRequestException('WooCommerce rechazó las claves'));
        await expect(service.connect(SCOPE, 'woocommerce', { site: 'x.com', token: 'a', secret: 'b' })).rejects.toThrow(/rechazó/);
        expect(conexiones).toHaveLength(0);
    });

    it('pide el Consumer Secret en WooCommerce', async () => {
        const { service } = construir();
        await expect(service.connect(SCOPE, 'woocommerce', { site: 'x.com', token: 'a' })).rejects.toThrow(/Consumer Secret/);
    });

    it('las credenciales se reconstruyen al usar la cuenta', () => {
        const { service } = construir();
        expect(service.authOf(cuenta() as any)).toEqual({ site: 'https://mitienda.com', token: 'ck_1', secret: 'cs_1' });
        expect(service.authOf(cuenta({ marketplace: 'shopify', externalUserId: 'a.myshopify.com', accessToken: 'shpat', secrets: null }) as any))
            .toEqual({ site: 'a.myshopify.com', token: 'shpat' });
    });
});

describe('importar publicaciones por SKU', () => {
    it('crea el producto como borrador y lo enlaza con su publicación', async () => {
        const { service, cliente, productos, enlaces } = construir({ conexiones: [cuenta()] });
        cliente.listListings.mockResolvedValue({ rows: [fila()], sinSku: 0, productos: 1, incompleto: false });

        const r = await service.importListings(SCOPE, 'woocommerce', undefined);

        expect(r).toMatchObject({ total: 1, nuevas: 1, yaEnCatalogo: 0, enlazadas: 1 });
        expect(productos[0]).toMatchObject({ sku: 'REL-01', name: 'Reloj', price: 90, stock: 7, status: 'draft', store: { id: 't1' } });
        expect(enlaces[0]).toMatchObject({ marketplace: 'woocommerce', externalId: '10', variationId: null, syncStatus: 'published', lastStockSynced: 7, connection: { id: 'wc1' } });
    });

    it('enlaza un producto existente SIN tocar su stock ni su precio', async () => {
        const existente = { id: 'p1', sku: 'REL-01', name: 'Mío', stock: 20, price: 100, store: { id: 't1' } };
        const { service, cliente, productos, enlaces, repoProductos } = construir({ conexiones: [cuenta()], productos: [existente] });
        cliente.listListings.mockResolvedValue({ rows: [fila()], sinSku: 0, productos: 1, incompleto: false });

        const r = await service.importListings(SCOPE, 'woocommerce', undefined);

        expect(r).toMatchObject({ yaEnCatalogo: 1, nuevas: 0, enlazadas: 1 });
        expect(productos[0]).toMatchObject({ stock: 20, price: 100, name: 'Mío' });
        expect(repoProductos.save).not.toHaveBeenCalled();
        expect(enlaces[0].product).toEqual({ id: 'p1' });
        expect(enlaces[0].lastStockSynced).toBe(7); // lo del canal, para que el desfase se vea
    });

    it('cada variante es su propio producto enlazado a la misma publicación', async () => {
        const { service, cliente, productos, enlaces } = construir({ conexiones: [cuenta()] });
        cliente.listListings.mockResolvedValue({
            rows: [
                fila({ sku: 'POLO-S', externalId: '20', variationId: '201', variation: 'Talla: S', title: 'Polo', stock: 4 }),
                fila({ sku: 'POLO-M', externalId: '20', variationId: '202', variation: 'Talla: M', title: 'Polo', stock: 5 }),
            ],
            sinSku: 1, productos: 1, incompleto: false,
        });

        const r = await service.importListings(SCOPE, 'woocommerce', undefined);

        expect(r).toMatchObject({ publicaciones: 1, total: 2, nuevas: 2, sinSku: 1 });
        expect(productos.map(p => [p.sku, p.name])).toEqual([['POLO-S', 'Polo - Talla: S'], ['POLO-M', 'Polo - Talla: M']]);
        expect(enlaces.map(e => [e.externalId, e.variationId])).toEqual([['20', '201'], ['20', '202']]);
    });

    it('la vista previa no escribe nada', async () => {
        const { service, cliente, productos, enlaces, avisos } = construir({ conexiones: [cuenta()] });
        cliente.listListings.mockResolvedValue({ rows: [fila()], sinSku: 0, productos: 1, incompleto: false });

        const r = await service.importListings(SCOPE, 'woocommerce', undefined, { dryRun: true });

        expect(r).toMatchObject({ total: 1, nuevas: 1, enlazadas: 0 });
        expect(productos).toHaveLength(0);
        expect(enlaces).toHaveLength(0);
        expect(avisos).toHaveLength(0);
    });

    it('un SKU de OTRA tienda del dueño no se importa ni se pisa', async () => {
        const ajeno = { id: 'p9', sku: 'REL-01', stock: 3, store: { id: 't2' } };
        const { service, cliente, enlaces } = construir({ conexiones: [cuenta()], productos: [ajeno] });
        cliente.listListings.mockResolvedValue({ rows: [fila()], sinSku: 0, productos: 1, incompleto: false });

        const r = await service.importListings(SCOPE, 'woocommerce', undefined);

        expect(r).toMatchObject({ enOtraTienda: 1, enlazadas: 0 });
        expect(enlaces).toHaveLength(0);
    });
});

describe('mantener las publicaciones al día', () => {
    const producto = { id: 'p1', sku: 'REL-01', stock: 20, price: 100 };
    const enlace = (over: any = {}) => ({
        id: 'e1', marketplace: 'woocommerce', externalId: '10', variationId: null, syncStatus: 'published',
        lastStockSynced: 20, product: producto, connection: { id: 'wc1' }, ...over,
    });

    it('actualiza estado, precio y stock del canal sin tocar el producto', async () => {
        const { service, cliente, enlaces } = construir({ conexiones: [cuenta()], productos: [producto], enlaces: [enlace()] });
        cliente.listListings.mockResolvedValue({ rows: [fila({ status: 'paused', stock: 3, regularPrice: 80 })], sinSku: 0, productos: 1, incompleto: false });

        const r = await service.refresh(cuenta() as any);

        expect(r).toEqual({ revisadas: 1, actualizadas: 1, ausentes: 0 });
        expect(enlaces[0]).toMatchObject({ syncStatus: 'paused', lastStockSynced: 3, regularPrice: 80 });
        expect(producto).toMatchObject({ stock: 20, price: 100 });
    });

    it('encuentra el enlace por SKU si el canal cambió el id de la publicación', async () => {
        const { service, cliente, enlaces } = construir({ conexiones: [cuenta()], productos: [producto], enlaces: [enlace({ externalId: 'viejo' })] });
        cliente.listListings.mockResolvedValue({ rows: [fila({ externalId: '99' })], sinSku: 0, productos: 1, incompleto: false });

        await service.refresh(cuenta() as any);

        expect(enlaces[0].externalId).toBe('99');
    });

    it('un producto que desapareció se pausa, pero solo si la lectura fue completa', async () => {
        const completa = construir({ conexiones: [cuenta()], productos: [producto], enlaces: [enlace()] });
        await completa.service.refresh(cuenta() as any);
        expect(completa.enlaces[0]).toMatchObject({ syncStatus: 'paused', lastError: expect.stringMatching(/ya no existe en WooCommerce/) });

        const cortada = construir({ conexiones: [cuenta()], productos: [producto], enlaces: [enlace()] });
        cortada.cliente.listListings.mockResolvedValue({ rows: [], sinSku: 0, productos: 0, incompleto: true });
        await cortada.service.refresh(cuenta() as any);
        expect(cortada.enlaces[0].syncStatus).toBe('published');
    });

    it('sin enlaces no lee el catálogo', async () => {
        const { service, cliente } = construir({ conexiones: [cuenta()] });
        expect(await service.refresh(cuenta() as any)).toEqual({ revisadas: 0, actualizadas: 0, ausentes: 0 });
        expect(cliente.listListings).not.toHaveBeenCalled();
    });
});

describe('stock hacia el canal', () => {
    it('manda el stock y el precio actuales a la publicación o variante enlazada', async () => {
        const producto = { id: 'p1', sku: 'POLO-M', stock: 6, price: 45 };
        const { service, cliente, enlaces } = construir({
            conexiones: [cuenta()], productos: [producto],
            enlaces: [{ id: 'e1', marketplace: 'woocommerce', externalId: '20', variationId: '202', syncStatus: 'published', product: producto, connection: { id: 'wc1' } }],
        });

        await service.pushInventory('woocommerce', 'p1', 'wc1');

        expect(cliente.setInventory).toHaveBeenCalledWith(
            { site: 'https://mitienda.com', token: 'ck_1', secret: 'cs_1' },
            { externalId: '20', variationId: '202' },
            { stock: 6, price: 45 },
        );
        expect(enlaces[0]).toMatchObject({ lastStockSynced: 6, lastError: null });
    });

    it('si el canal rechaza el envío, el motivo queda en el enlace y el error sube', async () => {
        const producto = { id: 'p1', sku: 'A', stock: 6, price: 45 };
        const { service, cliente, enlaces } = construir({
            conexiones: [cuenta()], productos: [producto],
            enlaces: [{ id: 'e1', marketplace: 'woocommerce', externalId: '20', variationId: null, syncStatus: 'published', product: producto, connection: { id: 'wc1' } }],
        });
        cliente.setInventory.mockRejectedValue(new Error('WooCommerce rechazó las claves'));

        await expect(service.pushInventory('woocommerce', 'p1', 'wc1')).rejects.toThrow(/rechazó/);
        expect(enlaces[0].lastError).toMatch(/rechazó las claves/);
    });

    it('un enlace pausado no recibe stock', async () => {
        const producto = { id: 'p1', sku: 'A', stock: 6, price: 45 };
        const { service, cliente } = construir({
            conexiones: [cuenta()], productos: [producto],
            enlaces: [{ id: 'e1', marketplace: 'woocommerce', externalId: '20', syncStatus: 'paused', product: producto, connection: { id: 'wc1' } }],
        });
        await service.pushInventory('woocommerce', 'p1', 'wc1');
        expect(cliente.setInventory).not.toHaveBeenCalled();
    });
});

describe('ventas', () => {
    it('una venta pagada descuenta el stock y lo propaga a los demás canales, sin devolverlo al de la venta', async () => {
        const producto = { id: 'p1', sku: 'REL-01', name: 'Reloj', stock: 20, store: { id: 't1' } };
        const { service, ventas, avisos, sync } = construir({ conexiones: [cuenta()], productos: [producto] });

        const nueva = await service.aplicarVenta(cuenta() as any, venta(), { soloRegistro: false });

        expect(nueva).toBe(true);
        expect(producto.stock).toBe(18);
        expect(sync.propagateStock).toHaveBeenCalledWith('u1', 'p1', 'wc1');
        // El id de la venta lleva la tienda: dos tiendas WooCommerce pueden repetir el número.
        expect(ventas[0]).toMatchObject({ marketplace: 'woocommerce', externalId: 'mitienda.com:501', customerName: 'Ana Ruiz', store: { id: 't1' }, connection: { id: 'wc1' }, itemsCount: 2 });
        expect(ventas[0].items[0]).toMatchObject({ sku: 'REL-01', stockBefore: 20, stockAfter: 18 });
        expect(avisos.map(a => a.type)).toContain('sale');
    });

    it('una venta de ANTES de conectar la cuenta queda como constancia: ni stock, ni correo, ni aviso', async () => {
        const producto = { id: 'p1', sku: 'REL-01', name: 'Reloj', stock: 20, store: { id: 't1' } };
        // La cuenta se conectó el 20 de octubre; la venta (por defecto del 9 de octubre) es anterior.
        const conectada = cuenta({ createdAt: new Date('2026-10-20T12:00:00Z') });
        const { service, ventas, avisos, sync } = construir({ conexiones: [conectada], productos: [producto] });
        const alertas = (service as any).saleAlerts;

        const registrada = await service.aplicarVenta(conectada as any, venta(), { soloRegistro: false });

        expect(registrada).toBe(true);
        expect(ventas).toHaveLength(1);
        expect(producto.stock).toBe(20);
        expect(sync.propagateStock).not.toHaveBeenCalled();
        expect(alertas.notificar).not.toHaveBeenCalled();
        expect(avisos).toHaveLength(0);
    });

    it('una venta de DESPUÉS de conectar sí descuenta el stock y avisa por correo', async () => {
        const producto = { id: 'p1', sku: 'REL-01', name: 'Reloj', stock: 20, store: { id: 't1' } };
        const conectada = cuenta({ createdAt: new Date('2026-10-01T12:00:00Z') });
        const { service, avisos } = construir({ conexiones: [conectada], productos: [producto] });
        const alertas = (service as any).saleAlerts;

        await service.aplicarVenta(conectada as any, venta(), { soloRegistro: false });

        expect(producto.stock).toBe(18);
        expect(alertas.notificar).toHaveBeenCalledTimes(1);
        expect(avisos.map(a => a.type)).toContain('sale');
    });

    it('la misma venta no se aplica dos veces', async () => {
        const producto = { id: 'p1', sku: 'REL-01', name: 'Reloj', stock: 20, store: { id: 't1' } };
        const { service, ventas } = construir({ conexiones: [cuenta()], productos: [producto] });

        await service.aplicarVenta(cuenta() as any, venta(), { soloRegistro: false });
        const segunda = await service.aplicarVenta(cuenta() as any, venta(), { soloRegistro: false });

        expect(segunda).toBe(false);
        expect(producto.stock).toBe(18);
        expect(ventas).toHaveLength(1);
    });

    it('una venta sin pagar o cancelada no se registra ni mueve el stock', async () => {
        const producto = { id: 'p1', sku: 'REL-01', name: 'Reloj', stock: 20, store: { id: 't1' } };
        const { service, ventas, sync } = construir({ conexiones: [cuenta()], productos: [producto] });

        expect(await service.aplicarVenta(cuenta() as any, venta({ paid: false, channelStatus: 'pending' }), { soloRegistro: false })).toBe(false);
        expect(producto.stock).toBe(20);
        expect(ventas).toHaveLength(0);
        expect(sync.propagateStock).not.toHaveBeenCalled();
    });

    it('si se paga más tarde, la siguiente consulta sí la registra', async () => {
        const producto = { id: 'p1', sku: 'REL-01', name: 'Reloj', stock: 20, store: { id: 't1' } };
        const { service } = construir({ conexiones: [cuenta()], productos: [producto] });

        await service.aplicarVenta(cuenta() as any, venta({ paid: false }), { soloRegistro: false });
        expect(await service.aplicarVenta(cuenta() as any, venta(), { soloRegistro: false })).toBe(true);
        expect(producto.stock).toBe(18);
    });

    it('un SKU que no está en el catálogo registra la venta pero no descuenta nada', async () => {
        const { service, ventas, sync } = construir({ conexiones: [cuenta()] });
        const nueva = await service.aplicarVenta(cuenta() as any, venta(), { soloRegistro: false });

        expect(nueva).toBe(true);
        expect(ventas).toHaveLength(1);
        expect(sync.propagateStock).not.toHaveBeenCalled();
    });

    it('avisa cuando el stock queda en cero', async () => {
        const producto = { id: 'p1', sku: 'REL-01', name: 'Reloj', stock: 2, store: { id: 't1' } };
        const { service, avisos } = construir({ conexiones: [cuenta()], productos: [producto] });
        await service.aplicarVenta(cuenta() as any, venta(), { soloRegistro: false });
        expect(avisos.some(a => a.type === 'low-stock' && a.severity === 'error')).toBe(true);
    });

    it('el historial deja la constancia sin tocar el stock ni avisar', async () => {
        const producto = { id: 'p1', sku: 'REL-01', name: 'Reloj', stock: 20, store: { id: 't1' } };
        const { service, cliente, ventas, avisos, sync } = construir({ conexiones: [cuenta()], productos: [producto] });
        cliente.listOrders.mockResolvedValue({ orders: [venta(), venta({ externalId: '502' })], incompleto: false });

        const r = await service.history(cuenta() as any, new Date('2026-07-01'), new Date('2026-10-08'));

        expect(r).toEqual({ registradas: 2, yaRegistradas: 0, incompleto: false });
        expect(ventas).toHaveLength(2);
        expect(producto.stock).toBe(20);
        expect(avisos).toHaveLength(0);
        expect(sync.propagateStock).not.toHaveBeenCalled();
        expect(cliente.listOrders.mock.calls[0][1]).toMatchObject({ createdFrom: new Date('2026-07-01'), createdTo: new Date('2026-10-08') });
    });

    it('importar el historial dos veces no duplica nada', async () => {
        const { service, cliente, ventas } = construir({ conexiones: [cuenta()] });
        cliente.listOrders.mockResolvedValue({ orders: [venta()], incompleto: false });
        await service.history(cuenta() as any, new Date('2026-07-01'), new Date('2026-10-08'));
        const segunda = await service.history(cuenta() as any, new Date('2026-07-01'), new Date('2026-10-08'));
        expect(segunda).toEqual({ registradas: 0, yaRegistradas: 1, incompleto: false });
        expect(ventas).toHaveLength(1);
    });

    it('la consulta periódica pide lo modificado en las últimas 48 horas', async () => {
        const { service, cliente } = construir({ conexiones: [cuenta()] });
        await service.poll(cuenta() as any);
        const { updatedFrom } = cliente.listOrders.mock.calls[0][1];
        const horas = (Date.now() - updatedFrom.getTime()) / 3_600_000;
        expect(horas).toBeGreaterThan(47.9);
        expect(horas).toBeLessThan(48.1);
    });

    it('si no se pudo guardar la venta por un error pasajero, se reintenta en la próxima consulta', async () => {
        const { service, cliente, repoProductos } = construir({ conexiones: [cuenta()] });
        const ventasRepo: any = (service as any).orders;
        ventasRepo.save.mockRejectedValueOnce(Object.assign(new Error('conexión caída'), { code: '08006' }));
        cliente.listOrders.mockResolvedValue({ orders: [venta()], incompleto: false });

        const primera = await service.poll(cuenta() as any);
        expect(primera.nuevos).toBe(0);
        const segunda = await service.poll(cuenta() as any);
        expect(segunda.nuevos).toBe(1);
        expect(repoProductos).toBeDefined();
    });
});

describe('registro en SyncService', () => {
    it('se da de alta para los tres canales al arrancar', () => {
        const { service, sync } = construir();
        service.onModuleInit();
        expect(sync.registerChannel).toHaveBeenCalledTimes(3);
        expect(sync.registerChannel.mock.calls.map((c: any[]) => c[0])).toEqual(['woocommerce', 'shopify', 'ripley']);
    });
});

// ── Ripley (Mirakl): la clave va en la cabecera, el estado del pedido se refleja y por ahora solo se lee ──

const cuentaRipley = (over: any = {}) => ({
    id: 'rp1', marketplace: 'ripley', externalUserId: '2001', externalNickname: 'Mi Tienda Ripley',
    accessToken: 'clave-de-prueba-1234567890', status: 'active', currency: 'PEN', secrets: { site: 'ripleyperu-prod.mirakl.net' },
    owner: { id: 'u1' }, store: { id: 't1' }, ...over,
});
const ventaRipley = (estado: string, saleState: any, extra: Partial<ChannelOrder> = {}, envio: any = {}): ChannelOrder => {
    const base = venta({ externalId: '22032706-A', channelStatus: estado, saleState, paid: !['canceled', 'refused'].includes(estado) }, [{ sku: 'REL-01', title: 'Reloj', quantity: 2, unitPrice: 45 }]);
    base.normalized.orderNumber = '22032706-A';
    base.normalized.details.channelStatus = estado;
    base.normalized.details.shipping = { ...base.normalized.details.shipping, status: estado, ...envio };
    base.costs = { shippingPaid: 5, shippingSellerCost: null, shippingType: 'comprador', discountAmount: 2, discountSellerFunded: null };
    base.normalized.costs = base.costs;
    return Object.assign(base, extra);
};

describe('Ripley: conectar', () => {
    it('sin dirección usa la de Perú, valida la clave contra la API y guarda la dirección en secrets', async () => {
        const { service, conexiones, cliente } = construir();
        cliente.verify.mockResolvedValue({ accountId: '2001', nickname: 'Mi Tienda Ripley', currency: 'PEN' });
        const r = await service.connect(SCOPE, 'ripley', { site: '', token: ' clave-de-prueba-1234567890 ', label: 'Principal' });

        expect(cliente.verify).toHaveBeenCalledWith({ site: 'ripleyperu-prod.mirakl.net', token: 'clave-de-prueba-1234567890', secret: undefined });
        expect(r).toMatchObject({ marketplace: 'ripley', nickname: 'Mi Tienda Ripley', currency: 'PEN' });
        expect(conexiones[0]).toMatchObject({ externalUserId: '2001', accessToken: 'clave-de-prueba-1234567890', secrets: { site: 'ripleyperu-prod.mirakl.net' }, status: 'active' });
    });

    it('una dirección que no es de Mirakl se rechaza ANTES de llamar a nadie (la clave no sale hacia otro sitio)', async () => {
        const { service, conexiones, cliente } = construir();
        await expect(service.connect(SCOPE, 'ripley', { site: 'https://malo.example.com', token: 'clave-de-prueba-1234567890' })).rejects.toThrow(/mirakl\.net/);
        await expect(service.connect(SCOPE, 'ripley', { site: 'ripleyperu-prod.mirakl.net.malo.com', token: 'clave-de-prueba-1234567890' })).rejects.toThrow(/mirakl\.net/);
        expect(cliente.verify).not.toHaveBeenCalled();
        expect(conexiones).toHaveLength(0);
    });

    it('una clave vacía o con espacios en medio se rechaza', async () => {
        const { service, cliente } = construir();
        await expect(service.connect(SCOPE, 'ripley', { site: '', token: '   ' })).rejects.toThrow(/Falta la clave/);
        await expect(service.connect(SCOPE, 'ripley', { site: '', token: 'clave con espacios 1234567890' })).rejects.toThrow(/no parece válida/);
        expect(cliente.verify).not.toHaveBeenCalled();
    });

    it('las credenciales se reconstruyen con la dirección guardada (o la de Perú si faltara)', () => {
        const { service } = construir();
        expect(service.authOf(cuentaRipley() as any)).toEqual({ site: 'ripleyperu-prod.mirakl.net', token: 'clave-de-prueba-1234567890' });
        expect(service.authOf(cuentaRipley({ secrets: null }) as any).site).toBe('ripleyperu-prod.mirakl.net');
    });
});

describe('Ripley: ventas y estados', () => {
    it('una venta nueva (esperando tu aceptación) se registra con su estado y su envío, descuenta stock y avisa', async () => {
        const producto = { id: 'p1', sku: 'REL-01', name: 'Reloj', stock: 20, store: { id: 't1' } };
        const { service, ventas, avisos } = construir({ conexiones: [cuentaRipley()], productos: [producto] });

        const nueva = await service.aplicarVenta(cuentaRipley() as any, ventaRipley('waiting_acceptance', 'pendiente'), { soloRegistro: false });

        expect(nueva).toBe(true);
        expect(producto.stock).toBe(18);
        expect(ventas[0]).toMatchObject({
            marketplace: 'ripley', externalId: '2001:22032706-A', status: 'waiting_acceptance', saleState: 'pendiente',
            shippingPaid: 5, shippingType: 'comprador', discountAmount: 2,
        });
        expect(avisos.map((a) => a.type)).toContain('sale');
    });

    it('cuando aceptas y despachas en el portal, la app solo cambia el estado: no duplica la venta ni toca el stock', async () => {
        const producto = { id: 'p1', sku: 'REL-01', name: 'Reloj', stock: 20, store: { id: 't1' } };
        const { service, ventas, sync } = construir({ conexiones: [cuentaRipley()], productos: [producto] });
        await service.aplicarVenta(cuentaRipley() as any, ventaRipley('waiting_acceptance', 'pendiente'), { soloRegistro: false });
        sync.propagateStock.mockClear();

        const otraVez = await service.aplicarVenta(
            cuentaRipley() as any,
            ventaRipley('shipped', 'enviado', {}, { trackingCode: 'TRK-99', carrier: 'Chilexpress' }),
            { soloRegistro: false },
        );

        expect(otraVez).toBe(false);
        expect(ventas).toHaveLength(1);
        expect(producto.stock).toBe(18);
        expect(sync.propagateStock).not.toHaveBeenCalled();
        expect(ventas[0]).toMatchObject({ status: 'shipped', saleState: 'enviado' });
        expect(ventas[0].details.shipping).toMatchObject({ status: 'shipped', trackingCode: 'TRK-99', carrier: 'Chilexpress' });
        expect(ventas[0].details.channelStatus).toBe('shipped');
    });

    it('recibida y cancelada también se reflejan, aunque una cancelada ya no «cuente» como venta nueva', async () => {
        const { service, ventas } = construir({ conexiones: [cuentaRipley()], productos: [{ id: 'p1', sku: 'REL-01', name: 'Reloj', stock: 20, store: { id: 't1' } }] });
        await service.aplicarVenta(cuentaRipley() as any, ventaRipley('waiting_acceptance', 'pendiente'), { soloRegistro: false });
        await service.aplicarVenta(cuentaRipley() as any, ventaRipley('received', 'entregado'), { soloRegistro: false });
        expect(ventas[0]).toMatchObject({ status: 'received', saleState: 'entregado' });
        await service.aplicarVenta(cuentaRipley() as any, ventaRipley('canceled', 'cancelado'), { soloRegistro: false });
        expect(ventas[0]).toMatchObject({ status: 'canceled', saleState: 'cancelado' });
    });

    it('al pasar a cancelada o devuelta avisa de ello para reponer el stock, con el estado que tenía antes', async () => {
        const { service, ventas, sync } = construir({ conexiones: [cuentaRipley()], productos: [{ id: 'p1', sku: 'REL-01', name: 'Reloj', stock: 20, store: { id: 't1' } }] });
        await service.aplicarVenta(cuentaRipley() as any, ventaRipley('waiting_acceptance', 'pendiente'), { soloRegistro: false });
        await service.aplicarVenta(cuentaRipley() as any, ventaRipley('shipped', 'enviado'), { soloRegistro: false });
        await service.aplicarVenta(cuentaRipley() as any, ventaRipley('closed', 'devuelto'), { soloRegistro: false });

        expect(sync.reponerStockDeVenta).toHaveBeenLastCalledWith(ventas[0].id, 'enviado', 'devuelto');
    });

    it('una venta cancelada o rechazada que nunca registramos no se crea', async () => {
        const { service, ventas } = construir({ conexiones: [cuentaRipley()] });
        expect(await service.aplicarVenta(cuentaRipley() as any, ventaRipley('refused', 'cancelado'), { soloRegistro: false })).toBe(false);
        expect(ventas).toHaveLength(0);
    });

    it('si nada cambió en Ripley, la consulta periódica no escribe en la base', async () => {
        const { service, ventas } = construir({ conexiones: [cuentaRipley()], productos: [{ id: 'p1', sku: 'REL-01', name: 'Reloj', stock: 20, store: { id: 't1' } }] });
        await service.aplicarVenta(cuentaRipley() as any, ventaRipley('shipping', 'pendiente'), { soloRegistro: false });
        const antes = JSON.stringify(ventas[0]);
        await service.aplicarVenta(cuentaRipley() as any, ventaRipley('shipping', 'pendiente'), { soloRegistro: false });
        expect(JSON.stringify(ventas[0])).toBe(antes);
    });

    it('el historial registra la venta sin tocar el stock ni avisar', async () => {
        const producto = { id: 'p1', sku: 'REL-01', name: 'Reloj', stock: 20, store: { id: 't1' } };
        const { service, ventas, avisos } = construir({ conexiones: [cuentaRipley()], productos: [producto] });
        await service.aplicarVenta(cuentaRipley() as any, ventaRipley('closed', 'entregado'), { soloRegistro: true });
        expect(ventas).toHaveLength(1);
        expect(producto.stock).toBe(20);
        expect(avisos).toHaveLength(0);
    });

    it('los otros canales siguen igual: una venta de WooCommerce ya registrada no cambia de estado', async () => {
        const { service, ventas } = construir({ conexiones: [cuenta()], productos: [{ id: 'p1', sku: 'REL-01', name: 'Reloj', stock: 20, store: { id: 't1' } }] });
        await service.aplicarVenta(cuenta() as any, venta(), { soloRegistro: false });
        await service.aplicarVenta(cuenta() as any, venta({ channelStatus: 'completed' }), { soloRegistro: false });
        expect(ventas[0].status).toBe('processing');
        expect(ventas[0].saleState).toBeUndefined();
    });
});

describe('Ripley: por ahora solo se lee', () => {
    const handlerDe = (sync: any, canal: string) => sync.registerChannel.mock.calls.find((c: any[]) => c[0] === canal)[1];

    it('un cambio de stock de un producto enlazado a Ripley NO se manda a Ripley', async () => {
        const producto = { id: 'p1', sku: 'REL-01', name: 'Reloj', stock: 5, price: 30 };
        const enlace = { id: 'e1', marketplace: 'ripley', product: producto, connection: { id: 'rp1' }, syncStatus: 'published', externalId: '77', variationId: null };
        const { service, sync, cliente } = construir({ conexiones: [cuentaRipley()], productos: [producto], enlaces: [enlace] });
        service.onModuleInit();

        await handlerDe(sync, 'ripley').pushInventory('p1', 'rp1');

        expect(cliente.setInventory).not.toHaveBeenCalled();
    });

    it('los demás canales siguen recibiendo su stock', async () => {
        const producto = { id: 'p1', sku: 'REL-01', name: 'Reloj', stock: 5, price: 30 };
        const enlace = { id: 'e1', marketplace: 'woocommerce', product: producto, connection: { id: 'wc1' }, syncStatus: 'published', externalId: '10', variationId: null };
        const { service, sync, cliente } = construir({ conexiones: [cuenta()], productos: [producto], enlaces: [enlace] });
        service.onModuleInit();

        await handlerDe(sync, 'woocommerce').pushInventory('p1', 'wc1');

        expect(cliente.setInventory).toHaveBeenCalledTimes(1);
    });
});

describe('Ripley: variantes al importar', () => {
    const ofertaDe = (sku: string, titulo: string, grupo: string | null, over: Partial<ChannelListingRow> = {}) =>
        fila({ sku, externalId: sku, title: titulo, groupKey: grupo, ...over });
    const lectura = (rows: ChannelListingRow[]) => ({ rows, sinSku: 0, productos: rows.length, incompleto: false });
    const rows = [
        ofertaDe('LCH-1', 'LONCHERA ROSADA TÉRMICA', 'PMP1'),
        ofertaDe('LCH-2', 'LONCHERA NEGRO TÉRMICA', 'PMP1'),
        ofertaDe('MOR-1', 'MORRAL DESSY', 'PMP2'),
        ofertaDe('MOR-2', 'MORRAL DESSY', 'PMP2'),
        ofertaDe('SOLO-1', 'CANGURO', 'PMP3'),
    ];
    const falsoAgrupador = () => ({
        aplicar: jest.fn(async () => ({ gruposCreados: 1, gruposActualizados: 0, variantesAgrupadas: 2, omitidos: [] })),
        aplicarManuales: jest.fn(async () => ({ gruposCreados: 1, gruposActualizados: 0, variantesAgrupadas: 2, omitidos: [] })),
    });

    it('la vista previa propone las familias, deja sin resolver las que no dicen en qué se diferencian y no escribe nada', async () => {
        const variantImport = falsoAgrupador();
        const { service, cliente, productos } = construir({ conexiones: [cuentaRipley()], variantImport });
        cliente.listListings.mockResolvedValue(lectura(rows));

        const r = await service.importListings(SCOPE, 'ripley', undefined, { dryRun: true });

        expect(r.variantes).toMatchObject({ grupos: 1, variantes: 2 });
        expect(r.variantes?.ejemplos[0]).toMatchObject({ parentSku: 'PMP1', nombre: 'LONCHERA TÉRMICA' });
        expect(r.variantes?.sinResolver.map((g) => g.parentSku)).toEqual(['PMP2']);
        expect(productos).toHaveLength(0);
        expect(variantImport.aplicar).not.toHaveBeenCalled();
    });

    it('las fichas sin resolver llevan la foto que Ripley da de cada producto', async () => {
        const { service, cliente } = construir({ conexiones: [cuentaRipley()], variantImport: falsoAgrupador() });
        cliente.listListings.mockResolvedValue(lectura([
            ofertaDe('MOR-1', 'MORRAL DESSY', 'PMP2', { productSku: 'PMP2-1' }),
            ofertaDe('MOR-2', 'MORRAL DESSY', 'PMP2', { productSku: 'PMP2-2' }),
        ]));
        cliente.fotosDeProductos.mockResolvedValue(new Map([['PMP2-1', 'https://x.mirakl.net/a.webp'], ['PMP2-2', 'https://x.mirakl.net/b.webp']]));

        const r = await service.importListings(SCOPE, 'ripley', undefined, { dryRun: true });

        expect(r.variantes?.sinResolver[0].fichas?.map((f) => f.imagen)).toEqual(['https://x.mirakl.net/a.webp', 'https://x.mirakl.net/b.webp']);
    });

    it('sugiere colores solo con fotos de Mirakl y con un máximo de familias', async () => {
        const { service } = construir({ conexiones: [cuentaRipley()] });
        const coloresConIA = jest.fn(async (f: any[]) => f.map((x) => ({ parentSku: x.parentSku, colores: {} })));
        (service as any).sync.coloresConIA = coloresConIA;
        const fam = (n: string) => ({ parentSku: n, fichas: [{ sku: 'a', nombre: 'a', imagen: 'https://x.mirakl.net/a.jpg' }, { sku: 'b', nombre: 'b', imagen: 'https://evil.com/b.jpg' }] });
        await service.sugerirColoresDeRipley(Array.from({ length: 12 }, (_, i) => fam('F' + i)));
        const enviadas = coloresConIA.mock.calls[0][0];
        expect(enviadas).toHaveLength(8);
        expect(enviadas[0].fichas[1].imagen).toBe('');
    });

    it('al importar crea los productos y los agrupa en el mismo paso, sobre los productos recién creados', async () => {
        const variantImport = falsoAgrupador();
        const { service, cliente, productos } = construir({ conexiones: [cuentaRipley()], variantImport });
        cliente.listListings.mockResolvedValue(lectura(rows));

        const r = await service.importListings(SCOPE, 'ripley', undefined, {});

        expect(productos).toHaveLength(5);
        expect(variantImport.aplicar).toHaveBeenCalledTimes(1);
        const [, grupos, vinculados] = variantImport.aplicar.mock.calls[0] as any[];
        expect(grupos.map((g: any) => g.parentSku)).toEqual(['PMP1']);
        expect([...vinculados.keys()].sort()).toEqual(['LCH-1', 'LCH-2', 'MOR-1', 'MOR-2', 'SOLO-1']);
        expect(vinculados.get('LCH-1')).toBe(productos.find((p) => p.sku === 'LCH-1'));
        expect(r.variantes?.aplicado).toMatchObject({ gruposCreados: 1 });
    });

    it('las familias estructuradas a mano se agrupan también, y mandan sobre la automática de la misma familia', async () => {
        const variantImport = falsoAgrupador();
        const { service, cliente } = construir({ conexiones: [cuentaRipley()], variantImport });
        cliente.listListings.mockResolvedValue(lectura(rows));
        const manual = { parentSku: 'PMP1', name: 'Lonchera', axes: ['Color'], variants: [{ sellerSku: 'LCH-1', values: { Color: 'Rosa' } }, { sellerSku: 'LCH-2', values: { Color: 'Negro' } }] };

        const r = await service.importListings(SCOPE, 'ripley', undefined, { gruposManuales: [manual] });

        expect(variantImport.aplicar).not.toHaveBeenCalled(); // la única familia automática era la manual
        expect(variantImport.aplicarManuales).toHaveBeenCalledWith(SCOPE, [manual], expect.any(Map));
        expect(r.variantes?.manuales).toMatchObject({ gruposCreados: 1 });
    });

    it('los otros canales no agrupan ni traen el bloque de variantes', async () => {
        const variantImport = falsoAgrupador();
        const { service, cliente } = construir({ conexiones: [cuenta()], variantImport });
        cliente.listListings.mockResolvedValue(lectura([ofertaDe('A', 'X ROJO', 'G'), ofertaDe('B', 'X AZUL', 'G')]));

        const r = await service.importListings(SCOPE, 'woocommerce', undefined, {});

        expect(r.variantes).toBeUndefined();
        expect(variantImport.aplicar).not.toHaveBeenCalled();
    });
});
