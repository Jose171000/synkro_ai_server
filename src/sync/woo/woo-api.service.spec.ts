import { BadRequestException } from '@nestjs/common';
import axios from 'axios';
import { describirErrorWoo, normalizarSitioWoo, WooApiService } from './woo-api.service';

jest.mock('axios');

/**
 * Lo que se protege: la dirección de la tienda se normaliza, los fallos salen
 * en español y con la causa probable, el catálogo se lee por páginas con tope,
 * y el stock se manda al producto o a la variación correctos.
 */
const auth = { site: 'mitienda.com/', token: 'ck_test', secret: 'cs_test' };
const ok = (data: any, paginas = 1) => ({ data, headers: { 'x-wp-totalpages': String(paginas) } });

describe('normalizarSitioWoo', () => {
    it('añade https, quita barras finales y rutas del panel', () => {
        expect(normalizarSitioWoo('mitienda.com')).toBe('https://mitienda.com');
        expect(normalizarSitioWoo('  https://MiTienda.com/  ')).toBe('https://mitienda.com');
        expect(normalizarSitioWoo('https://mitienda.com/wp-admin/admin.php?page=wc')).toBe('https://mitienda.com');
        expect(normalizarSitioWoo('https://mitienda.com/wp-json/wc/v3')).toBe('https://mitienda.com');
        expect(normalizarSitioWoo('https://mitienda.com/tienda/')).toBe('https://mitienda.com/tienda');
    });

    it('rechaza lo vacío y lo que no es una dirección', () => {
        for (const malo of ['', '   ', 'hola mundo', 'http://']) {
            expect(() => normalizarSitioWoo(malo)).toThrow('Escribe la dirección de tu tienda, por ejemplo https://mitienda.com');
        }
    });

    it('exige https salvo en localhost', () => {
        expect(() => normalizarSitioWoo('http://mitienda.com')).toThrow(BadRequestException);
        expect(normalizarSitioWoo('http://localhost:8080')).toBe('http://localhost:8080');
    });
});

describe('describirErrorWoo', () => {
    it('401 y 403: claves rechazadas', () => {
        expect(describirErrorWoo({ response: { status: 401, data: {} } })).toContain('rechazó las claves');
        expect(describirErrorWoo({ response: { status: 403, data: { message: 'x' } } })).toContain('lectura y escritura');
    });

    it('404: API no encontrada', () => {
        const m = describirErrorWoo({ response: { status: 404, data: {} } });
        expect(m).toContain('No se encontró la API de WooCommerce');
        expect(m).toContain('Simple');
    });

    it('HTML: lo dice con claridad, incluso con 403', () => {
        const m = describirErrorWoo({ response: { status: 403, data: '<!DOCTYPE html><html>Bloqueado</html>', headers: { 'content-type': 'text/html' } } });
        expect(m).toContain('página web');
        expect(m).not.toContain('rechazó las claves');
    });

    it('sin conexión', () => {
        expect(describirErrorWoo({ code: 'ENOTFOUND', message: 'getaddrinfo' })).toContain('No se pudo conectar');
        expect(describirErrorWoo({ code: 'ECONNREFUSED' })).toContain('No se pudo conectar');
        expect(describirErrorWoo({ code: 'ECONNABORTED', message: 'timeout of 20000ms exceeded' })).toContain('No se pudo conectar');
    });

    it('otros errores llevan el código y el mensaje de WooCommerce', () => {
        expect(describirErrorWoo({ response: { status: 400, data: { message: 'Stock inválido' } } }))
            .toBe('Error de WooCommerce (HTTP 400): Stock inválido');
        expect(describirErrorWoo({ response: { status: 500, data: {} } })).toBe('Error de WooCommerce (HTTP 500)');
    });
});

describe('WooApiService', () => {
    let http: { get: jest.Mock; put: jest.Mock };
    let servicio: WooApiService;

    beforeEach(() => {
        http = { get: jest.fn(), put: jest.fn() };
        (axios.create as jest.Mock).mockReturnValue(http);
        servicio = new WooApiService();
    });

    it('crea el cliente con la URL de la API, Basic auth y User-Agent', async () => {
        http.get.mockResolvedValue(ok([]));
        await servicio.verify(auth);
        expect(axios.create).toHaveBeenCalledWith(expect.objectContaining({
            baseURL: 'https://mitienda.com/wp-json/wc/v3',
            timeout: 20000,
            auth: { username: 'ck_test', password: 'cs_test' },
            headers: { 'User-Agent': 'Synkro-AI' },
        }));
    });

    describe('verify', () => {
        it('devuelve el host como cuenta y la moneda de la tienda', async () => {
            http.get.mockImplementation(async (url: string) =>
                url === '/products' ? ok([]) : ok({ id: 'woocommerce_currency', value: 'PEN' }));
            expect(await servicio.verify(auth)).toEqual({ accountId: 'mitienda.com', nickname: 'mitienda.com', currency: 'PEN' });
            expect(http.get).toHaveBeenCalledWith('/products', { params: { per_page: 1 } });
        });

        it('si falla la moneda, currency es null pero la cuenta es válida', async () => {
            http.get.mockImplementation(async (url: string) => {
                if (url === '/products') return ok([]);
                throw { response: { status: 404, data: {} } };
            });
            expect((await servicio.verify(auth)).currency).toBeNull();
        });

        it('traduce un 401', async () => {
            http.get.mockRejectedValue({ response: { status: 401, data: {} } });
            await expect(servicio.verify(auth)).rejects.toThrow('WooCommerce rechazó las claves');
        });

        it('traduce un 404', async () => {
            http.get.mockRejectedValue({ response: { status: 404, data: {} } });
            await expect(servicio.verify(auth)).rejects.toThrow('No se encontró la API de WooCommerce');
        });

        it('una respuesta HTML con código 200 se explica', async () => {
            http.get.mockResolvedValue({ data: '<html>Just a moment...</html>', headers: {} });
            await expect(servicio.verify(auth)).rejects.toThrow('página web');
        });

        it('rechaza una dirección inválida antes de llamar', async () => {
            await expect(servicio.verify({ ...auth, site: '' })).rejects.toThrow('Escribe la dirección de tu tienda');
            expect(http.get).not.toHaveBeenCalled();
        });
    });

    describe('listListings', () => {
        const producto = (id: number, extra: any = {}) => ({
            id, name: `P${id}`, type: 'simple', status: 'publish', sku: `SKU-${id}`, regular_price: '10',
            manage_stock: true, stock_quantity: 1, images: [], ...extra,
        });

        it('pagina con x-wp-totalpages y lee las variaciones de los productos variables', async () => {
            http.get.mockImplementation(async (url: string, cfg: any) => {
                if (url === '/settings/general/woocommerce_currency') return ok({ value: 'PEN' });
                if (url === '/products') {
                    return cfg.params.page === 1
                        ? ok([producto(1), producto(2, { type: 'variable', sku: '', variations: [21, 22] })], 2)
                        : ok([producto(3)], 2);
                }
                if (url === '/products/2/variations') {
                    return ok([
                        { id: 21, sku: 'V-21', regular_price: '10', manage_stock: true, stock_quantity: 2, attributes: [] },
                        { id: 22, sku: '', regular_price: '10', attributes: [] },
                    ]);
                }
                throw new Error(`URL inesperada ${url}`);
            });

            const r = await servicio.listListings(auth);
            expect(r.productos).toBe(3);
            expect(r.incompleto).toBe(false);
            expect(r.sinSku).toBe(1);
            expect(r.rows.map(x => x.sku)).toEqual(['SKU-1', 'V-21', 'SKU-3']);
            expect(r.rows[0].currency).toBe('PEN');
            expect(http.get).toHaveBeenCalledWith('/products', { params: { per_page: 100, page: 1, status: 'any' } });
            expect(http.get).toHaveBeenCalledWith('/products', { params: { per_page: 100, page: 2, status: 'any' } });
        });

        it('se detiene en 5000 productos y lo marca incompleto', async () => {
            const pagina = (n: number) => Array.from({ length: 100 }, (_, i) => producto(n * 100 + i));
            http.get.mockImplementation(async (url: string, cfg: any) => {
                if (url === '/settings/general/woocommerce_currency') return ok({ value: 'PEN' });
                return ok(pagina(cfg.params.page), 80);
            });
            const r = await servicio.listListings(auth);
            expect(r.productos).toBe(5000);
            expect(r.incompleto).toBe(true);
            const llamadasProductos = http.get.mock.calls.filter(c => c[0] === '/products');
            expect(llamadasProductos).toHaveLength(50);
        });

        it('exactamente 5000 productos y sin más páginas no es incompleto', async () => {
            http.get.mockImplementation(async (url: string, cfg: any) => {
                if (url === '/settings/general/woocommerce_currency') return ok({ value: 'PEN' });
                return ok(Array.from({ length: 100 }, (_, i) => producto(cfg.params.page * 100 + i)), 50);
            });
            const r = await servicio.listListings(auth);
            expect(r.productos).toBe(5000);
            expect(r.incompleto).toBe(false);
        });
    });

    describe('setInventory', () => {
        it('actualiza un producto simple', async () => {
            http.put.mockResolvedValue(ok({}));
            await servicio.setInventory(auth, { externalId: '101', variationId: null }, { stock: 8 });
            expect(http.put).toHaveBeenCalledWith('/products/101', {
                manage_stock: true, stock_quantity: 8, stock_status: 'instock',
            });
        });

        it('actualiza una variación y su precio, y con stock 0 la marca agotada', async () => {
            http.put.mockResolvedValue(ok({}));
            await servicio.setInventory(auth, { externalId: '200', variationId: '201' }, { stock: 0, price: 79.9 });
            expect(http.put).toHaveBeenCalledWith('/products/200/variations/201', {
                manage_stock: true, stock_quantity: 0, stock_status: 'outofstock', regular_price: '79.90',
            });
        });

        it('nunca manda stock negativo', async () => {
            http.put.mockResolvedValue(ok({}));
            await servicio.setInventory(auth, { externalId: '1', variationId: null }, { stock: -4, price: null });
            expect(http.put.mock.calls[0][1]).toEqual({ manage_stock: true, stock_quantity: 0, stock_status: 'outofstock' });
        });

        it('traduce los errores', async () => {
            http.put.mockRejectedValue({ response: { status: 401, data: {} } });
            await expect(servicio.setInventory(auth, { externalId: '1', variationId: null }, { stock: 1 }))
                .rejects.toThrow('rechazó las claves');
        });
    });

    describe('listOrders', () => {
        const pedido = (id: number) => ({
            id, number: String(id), status: 'processing', currency: 'PEN', total: '10.00',
            date_created_gmt: '2026-10-10T14:00:00', billing: {}, shipping: {}, line_items: [],
        });

        it('manda los filtros de fecha en ISO y normaliza los pedidos', async () => {
            http.get.mockResolvedValue(ok([pedido(1), pedido(2)]));
            const r = await servicio.listOrders(auth, {
                createdFrom: new Date('2026-10-01T00:00:00Z'),
                createdTo: new Date('2026-10-12T00:00:00Z'),
                updatedFrom: new Date('2026-10-05T00:00:00Z'),
                max: 10,
            });
            expect(r.orders.map(o => o.externalId)).toEqual(['1', '2']);
            expect(r.incompleto).toBe(false);
            expect(http.get).toHaveBeenCalledWith('/orders', {
                params: {
                    per_page: 100, orderby: 'date', order: 'desc', dates_are_gmt: true, page: 1,
                    after: '2026-10-01T00:00:00.000Z', before: '2026-10-12T00:00:00.000Z',
                    modified_after: '2026-10-05T00:00:00.000Z',
                },
            });
        });

        it('pagina hasta el tope y marca incompleto si quedaban más', async () => {
            http.get.mockImplementation(async (_u: string, cfg: any) =>
                ok(Array.from({ length: 100 }, (_, i) => pedido(cfg.params.page * 1000 + i)), 5));
            const r = await servicio.listOrders(auth, { max: 150 });
            expect(r.orders).toHaveLength(150);
            expect(r.incompleto).toBe(true);
            expect(http.get).toHaveBeenCalledTimes(2);
        });

        it('si el tope coincide con el total no es incompleto', async () => {
            http.get.mockResolvedValue(ok([pedido(1), pedido(2)], 1));
            const r = await servicio.listOrders(auth, { max: 2 });
            expect(r.orders).toHaveLength(2);
            expect(r.incompleto).toBe(false);
        });
    });
});
