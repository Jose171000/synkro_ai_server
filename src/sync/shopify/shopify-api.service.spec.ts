import { BadRequestException } from '@nestjs/common';
import axios from 'axios';
import { describirErrorShopify, normalizarDominioShopify, ShopifyApiService } from './shopify-api.service';

jest.mock('axios');
const post = axios.post as unknown as jest.Mock;

const auth = { site: 'mitienda', token: 'shpat_abc' };
const ok = (data: any) => ({ status: 200, data: { data } });

describe('normalizarDominioShopify', () => {
    it.each([
        ['mitienda', 'mitienda.myshopify.com'],
        ['MiTienda.myshopify.com', 'mitienda.myshopify.com'],
        ['https://mitienda.myshopify.com/admin', 'mitienda.myshopify.com'],
        ['  http://mitienda.myshopify.com/', 'mitienda.myshopify.com'],
        ['mitienda.myshopify.com/admin/products?x=1', 'mitienda.myshopify.com'],
    ])('%s → %s', (entrada, esperado) => {
        expect(normalizarDominioShopify(entrada)).toBe(esperado);
    });

    it('un dominio propio se rechaza explicando qué hace falta', () => {
        expect(() => normalizarDominioShopify('mitienda.com')).toThrow(BadRequestException);
        expect(() => normalizarDominioShopify('https://www.mitienda.com')).toThrow(/Configuración → Dominios/);
    });

    it('vacío se rechaza', () => {
        expect(() => normalizarDominioShopify('  ')).toThrow(BadRequestException);
    });
});

describe('describirErrorShopify', () => {
    it('traduce los códigos HTTP', () => {
        expect(describirErrorShopify({ response: { status: 401 } })).toMatch(/shpat_/);
        const m403 = describirErrorShopify({ response: { status: 403 } });
        for (const s of ['read_products', 'write_products', 'read_inventory', 'write_inventory', 'read_orders', 'read_locations']) {
            expect(m403).toContain(s);
        }
        expect(describirErrorShopify({ response: { status: 404 } })).toMatch(/dominio/);
        expect(describirErrorShopify({ response: { status: 423 } })).toMatch(/cerrada o pausada/);
        expect(describirErrorShopify({ response: { status: 402 } })).toMatch(/cerrada o pausada/);
    });

    it('HTML, red caída y errores de GraphQL', () => {
        expect(describirErrorShopify({ response: { status: 200, data: '<html>hola</html>' } })).toMatch(/página web/);
        expect(describirErrorShopify({ code: 'ENOTFOUND', message: 'getaddrinfo' })).toMatch(/No se pudo contactar/);
        expect(describirErrorShopify({ response: { status: 400, data: { errors: [{ message: 'campo malo' }] } } })).toContain('campo malo');
    });
});

describe('ShopifyApiService', () => {
    let svc: ShopifyApiService;

    beforeEach(() => {
        post.mockReset();
        svc = new ShopifyApiService();
    });

    describe('transporte', () => {
        it('manda el POST al dominio normalizado con el token y timeout', async () => {
            post.mockResolvedValueOnce(ok({ shop: { name: 'Mi Tienda', myshopifyDomain: 'mitienda.myshopify.com', currencyCode: 'PEN' } }));
            post.mockResolvedValueOnce(ok({ currentAppInstallation: { accessScopes: [] } }));
            await svc.verify({ ...auth, site: 'https://MiTienda.myshopify.com/admin' }).catch(() => undefined);
            const [url, body, cfg] = post.mock.calls[0];
            expect(url).toBe('https://mitienda.myshopify.com/admin/api/2025-01/graphql.json');
            expect(body.query).toContain('myshopifyDomain');
            expect(cfg.timeout).toBe(20000);
            expect(cfg.headers['X-Shopify-Access-Token']).toBe('shpat_abc');
            expect(cfg.headers['Content-Type']).toBe('application/json');
        });

        it('un error HTTP sale traducido', async () => {
            post.mockRejectedValueOnce({ response: { status: 401, data: {} } });
            await expect(svc.verify(auth)).rejects.toThrow(/shpat_/);
        });

        it('errores de GraphQL se lanzan', async () => {
            post.mockResolvedValueOnce({ status: 200, data: { errors: [{ message: 'Field no existe' }] } });
            await expect(svc.verify(auth)).rejects.toThrow(/Field no existe/);
        });

        it('reintenta si hay throttling y termina bien', async () => {
            const espera = jest.spyOn(global, 'setTimeout').mockImplementation(((fn: any) => { fn(); return 0 as any; }) as any);
            try {
                const throttled = { status: 200, data: { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] } };
                post.mockResolvedValueOnce(throttled);
                post.mockResolvedValueOnce(throttled);
                post.mockResolvedValueOnce(ok({ shop: { name: 'T', myshopifyDomain: 'mitienda.myshopify.com', currencyCode: 'PEN' } }));
                post.mockResolvedValueOnce(ok({ currentAppInstallation: { accessScopes: [] } }));
                await expect(svc.verify(auth)).rejects.toThrow(/faltan permisos/);
                expect(post).toHaveBeenCalledTimes(4);
            } finally {
                espera.mockRestore();
            }
        });

        it('se rinde tras 3 reintentos de throttling', async () => {
            const espera = jest.spyOn(global, 'setTimeout').mockImplementation(((fn: any) => { fn(); return 0 as any; }) as any);
            try {
                post.mockResolvedValue({ status: 200, data: { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] } });
                await expect(svc.verify(auth)).rejects.toThrow(/limitando/);
                expect(post).toHaveBeenCalledTimes(4);
            } finally {
                espera.mockRestore();
            }
        });
    });

    describe('verify', () => {
        const tienda = ok({ shop: { name: 'Mi Tienda', myshopifyDomain: 'mitienda.myshopify.com', currencyCode: 'PEN' } });
        const scopes = (handles: string[]) => ok({ currentAppInstallation: { accessScopes: handles.map(handle => ({ handle })) } });

        it('devuelve cuenta, nombre y moneda con todos los permisos', async () => {
            post.mockResolvedValueOnce(tienda);
            post.mockResolvedValueOnce(scopes(['read_products', 'write_products', 'read_inventory', 'write_inventory', 'read_orders', 'read_locations']));
            await expect(svc.verify(auth)).resolves.toEqual({ accountId: 'mitienda.myshopify.com', nickname: 'Mi Tienda', currency: 'PEN' });
        });

        it('lista exactamente los permisos que faltan', async () => {
            post.mockResolvedValueOnce(tienda);
            post.mockResolvedValueOnce(scopes(['read_products', 'write_products', 'read_inventory']));
            const e: any = await svc.verify(auth).catch(x => x);
            expect(e).toBeInstanceOf(BadRequestException);
            expect(e.message).toContain('write_inventory, read_orders, read_locations');
            expect(e.message).not.toContain('read_products');
        });

        it('si la consulta de permisos falla, la ignora', async () => {
            post.mockResolvedValueOnce(tienda);
            post.mockRejectedValueOnce({ response: { status: 500, data: {} } });
            await expect(svc.verify(auth)).resolves.toMatchObject({ accountId: 'mitienda.myshopify.com' });
        });
    });

    describe('listListings', () => {
        const producto = (n: number, extra: any = {}) => ({
            id: `gid://shopify/Product/${n}`, title: `P${n}`, status: 'ACTIVE', onlineStoreUrl: null, featuredImage: null,
            images: { nodes: [] },
            variants: {
                pageInfo: { hasNextPage: false },
                nodes: [{
                    id: `gid://shopify/ProductVariant/${n}0`, sku: `SKU-${n}`, title: 'Default Title', price: '10.00',
                    compareAtPrice: null, inventoryQuantity: n, selectedOptions: [{ name: 'Title', value: 'Default Title' }], image: null,
                }],
            },
            ...extra,
        });

        it('pagina por cursor y arma las filas', async () => {
            post.mockResolvedValueOnce(ok({ shop: { currencyCode: 'USD' } }));
            post.mockResolvedValueOnce(ok({ products: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [producto(1), producto(2)] } }));
            post.mockResolvedValueOnce(ok({ products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [producto(3)] } }));
            const r = await svc.listListings(auth);
            expect(r.productos).toBe(3);
            expect(r.incompleto).toBe(false);
            expect(r.rows.map(x => x.sku)).toEqual(['SKU-1', 'SKU-2', 'SKU-3']);
            expect(r.rows[0].currency).toBe('USD');
            expect(post.mock.calls[1][1].variables.cursor).toBeNull();
            expect(post.mock.calls[2][1].variables.cursor).toBe('c1');
        });

        it('marca incompleto si una página de variantes tiene más', async () => {
            post.mockResolvedValueOnce(ok({ shop: { currencyCode: 'USD' } }));
            const p = producto(1);
            p.variants.pageInfo.hasNextPage = true;
            post.mockResolvedValueOnce(ok({ products: { pageInfo: { hasNextPage: false }, nodes: [p] } }));
            expect((await svc.listListings(auth)).incompleto).toBe(true);
        });

        it('se detiene en 5000 productos y marca incompleto', async () => {
            post.mockResolvedValueOnce(ok({ shop: { currencyCode: 'USD' } }));
            const pagina = Array.from({ length: 50 }, (_, i) => producto(i + 1));
            post.mockResolvedValue(ok({ products: { pageInfo: { hasNextPage: true, endCursor: 'x' }, nodes: pagina } }));
            const r = await svc.listListings(auth);
            expect(r.productos).toBe(5000);
            expect(r.incompleto).toBe(true);
        });
    });

    describe('setInventory', () => {
        const variante = (niveles: any[]) => ok({
            productVariant: { id: 'gid://shopify/ProductVariant/789', inventoryItem: { id: 'gid://shopify/InventoryItem/55', inventoryLevels: { nodes: niveles } } },
        });
        const nivel = (id: string, isActive: boolean) => ({ location: { id, isActive } });

        it('elige la primera ubicación activa y manda stock y precio con los ids correctos', async () => {
            post.mockResolvedValueOnce(variante([nivel('gid://shopify/Location/1', false), nivel('gid://shopify/Location/2', true)]));
            post.mockResolvedValueOnce(ok({ inventorySetQuantities: { userErrors: [] } }));
            post.mockResolvedValueOnce(ok({ productVariantsBulkUpdate: { userErrors: [] } }));

            await svc.setInventory(auth, { externalId: '456', variationId: '789' }, { stock: 8, price: 19.9 });

            expect(post).toHaveBeenCalledTimes(3);
            expect(post.mock.calls[0][1].variables).toEqual({ id: 'gid://shopify/ProductVariant/789' });
            const inv = post.mock.calls[1][1];
            expect(inv.query).toContain('inventorySetQuantities');
            expect(inv.variables.input).toEqual({
                name: 'available', reason: 'correction', ignoreCompareQuantity: true,
                quantities: [{ inventoryItemId: 'gid://shopify/InventoryItem/55', locationId: 'gid://shopify/Location/2', quantity: 8 }],
            });
            const precio = post.mock.calls[2][1];
            expect(precio.query).toContain('productVariantsBulkUpdate');
            expect(precio.variables).toEqual({
                productId: 'gid://shopify/Product/456',
                variants: [{ id: 'gid://shopify/ProductVariant/789', price: '19.90' }],
            });
        });

        it('sin precio no toca el precio', async () => {
            post.mockResolvedValueOnce(variante([nivel('gid://shopify/Location/1', true)]));
            post.mockResolvedValueOnce(ok({ inventorySetQuantities: { userErrors: [] } }));
            await svc.setInventory(auth, { externalId: '456', variationId: '789' }, { stock: 3 });
            expect(post).toHaveBeenCalledTimes(2);
        });

        it('sin variationId busca la primera variante del producto', async () => {
            post.mockResolvedValueOnce(ok({ product: { variants: { nodes: [{ id: 'gid://shopify/ProductVariant/789' }] } } }));
            post.mockResolvedValueOnce(variante([nivel('gid://shopify/Location/1', true)]));
            post.mockResolvedValueOnce(ok({ inventorySetQuantities: { userErrors: [] } }));
            await svc.setInventory(auth, { externalId: '456', variationId: null }, { stock: 3 });
            expect(post.mock.calls[0][1].variables).toEqual({ id: 'gid://shopify/Product/456' });
            expect(post.mock.calls[1][1].variables).toEqual({ id: 'gid://shopify/ProductVariant/789' });
        });

        it('sin ubicaciones activas lanza un error claro', async () => {
            post.mockResolvedValueOnce(variante([nivel('gid://shopify/Location/1', false)]));
            await expect(svc.setInventory(auth, { externalId: '456', variationId: '789' }, { stock: 1 }))
                .rejects.toThrow('Esta variante no tiene inventario en ninguna ubicación');
        });

        it('lanza los userErrors de la mutation', async () => {
            post.mockResolvedValueOnce(variante([nivel('gid://shopify/Location/1', true)]));
            post.mockResolvedValueOnce(ok({ inventorySetQuantities: { userErrors: [{ field: ['x'], message: 'Cantidad inválida' }] } }));
            await expect(svc.setInventory(auth, { externalId: '456', variationId: '789' }, { stock: 1 }))
                .rejects.toThrow(/Cantidad inválida/);
        });
    });

    describe('listOrders', () => {
        const pedido = (n: number) => ({
            id: `gid://shopify/Order/${n}`, name: `#${1000 + n}`, createdAt: '2026-10-01T00:00:00Z', cancelledAt: null,
            displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED',
            currentTotalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'PEN' } },
            lineItems: { nodes: [] }, fulfillments: [],
        });

        it('arma el filtro, pagina y respeta el máximo', async () => {
            post.mockResolvedValueOnce(ok({ orders: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [pedido(1), pedido(2)] } }));
            post.mockResolvedValueOnce(ok({ orders: { pageInfo: { hasNextPage: true, endCursor: 'c2' }, nodes: [pedido(3), pedido(4)] } }));
            const r = await svc.listOrders(auth, {
                createdFrom: new Date('2026-09-01T00:00:00Z'),
                createdTo: new Date('2026-10-05T00:00:00Z'),
                updatedFrom: new Date('2026-10-01T00:00:00Z'),
                max: 3,
            });
            expect(post.mock.calls[0][1].variables.filtro).toBe(
                'created_at:>=2026-09-01T00:00:00.000Z AND created_at:<=2026-10-05T00:00:00.000Z AND updated_at:>=2026-10-01T00:00:00.000Z',
            );
            expect(post.mock.calls[1][1].variables.cursor).toBe('c1');
            expect(r.orders.map(o => o.externalId)).toEqual(['1', '2', '3']);
            expect(r.incompleto).toBe(true);
        });

        it('sin filtros manda filtro nulo y termina cuando no hay más páginas', async () => {
            post.mockResolvedValueOnce(ok({ orders: { pageInfo: { hasNextPage: false }, nodes: [pedido(1)] } }));
            const r = await svc.listOrders(auth, { max: 100 });
            expect(post.mock.calls[0][1].variables.filtro).toBeNull();
            expect(r).toMatchObject({ incompleto: false });
            expect(r.orders[0].normalized.orderNumber).toBe('#1001');
        });
    });
});
