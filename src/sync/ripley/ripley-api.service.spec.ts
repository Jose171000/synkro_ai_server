import axios from 'axios';
import { describirErrorRipley, RipleyApiService } from './ripley-api.service';

jest.mock('axios');
const mockedGet = axios.get as jest.Mock;

const AUTH = { site: 'ripleyperu-prod.mirakl.net', token: 'clave-de-prueba-1234567890' };
const oferta = (n: number) => ({ shop_sku: `SKU-${n}`, offer_id: n, price: 10, quantity: 1, product_title: `Producto ${n}`, active: true });
const pedido = (id: string, fecha: string) => ({ order_id: id, order_state: 'SHIPPING', created_date: fecha, total_price: 10, order_lines: [] });

beforeEach(() => mockedGet.mockReset());

describe('Ripley: llamadas a la API', () => {
    it('la clave va tal cual en Authorization, a la dirección validada, sin seguir redirecciones', async () => {
        mockedGet.mockResolvedValue({ data: { shop_id: 2001, shop_name: 'Mi Tienda', currency_iso_code: 'pen' } });
        const r = await new RipleyApiService().verify({ site: 'HTTPS://RipleyPeru-Prod.mirakl.net/', token: ' clave-de-prueba-1234567890 ' });

        const [url, opciones] = mockedGet.mock.calls[0];
        expect(url).toBe('https://ripleyperu-prod.mirakl.net/api/account');
        expect(opciones.headers).toEqual({ Authorization: 'clave-de-prueba-1234567890', Accept: 'application/json' });
        expect(opciones.maxRedirects).toBe(0);
        expect(r).toEqual({ accountId: '2001', nickname: 'Mi Tienda', currency: 'PEN' });
    });

    it('nunca llama a una dirección que no sea de Mirakl, aunque llegara una guardada mal', async () => {
        await expect(new RipleyApiService().verify({ site: 'malo.example.com', token: 'clave-de-prueba-1234567890' })).rejects.toThrow(/mirakl\.net/);
        expect(mockedGet).not.toHaveBeenCalled();
    });

    it('una clave mala (401) da un mensaje que dice qué hacer', async () => {
        mockedGet.mockRejectedValue({ response: { status: 401 } });
        await expect(new RipleyApiService().verify(AUTH)).rejects.toThrow(/rechazó la clave.*portal de vendedor/);
    });

    it('si Ripley responde pero no dice qué tienda es, no se conecta', async () => {
        mockedGet.mockResolvedValue({ data: { algo: 1 } });
        await expect(new RipleyApiService().verify(AUTH)).rejects.toThrow(/no dijo qué tienda/);
    });

    it('lee las ofertas por páginas de 100 hasta el total', async () => {
        const p1 = Array.from({ length: 100 }, (_, i) => oferta(i));
        const p2 = Array.from({ length: 30 }, (_, i) => oferta(100 + i));
        mockedGet
            .mockResolvedValueOnce({ data: { offers: p1, total_count: 130 } })
            .mockResolvedValueOnce({ data: { offers: p2, total_count: 130 } });

        const r = await new RipleyApiService().listListings(AUTH);

        expect(mockedGet).toHaveBeenCalledTimes(2);
        expect(mockedGet.mock.calls[0][1].params).toEqual({ paginate: true, max: 100, offset: 0 });
        expect(mockedGet.mock.calls[1][1].params).toEqual({ paginate: true, max: 100, offset: 100 });
        expect(r).toMatchObject({ productos: 130, sinSku: 0, incompleto: false });
        expect(r.rows).toHaveLength(130);
    });

    it('las ofertas sin SKU se cuentan aparte', async () => {
        mockedGet.mockResolvedValue({ data: { offers: [oferta(1), { ...oferta(2), shop_sku: '' }], total_count: 2 } });
        const r = await new RipleyApiService().listListings(AUTH);
        expect(r).toMatchObject({ productos: 2, sinSku: 1 });
        expect(r.rows.map((f) => f.sku)).toEqual(['SKU-1']);
    });

    it('un catálogo enorme se corta en 5.000 y avisa que quedó incompleto', async () => {
        mockedGet.mockImplementation(async (_u: string, o: any) => ({ data: { offers: Array.from({ length: 100 }, (_, i) => oferta(o.params.offset + i)), total_count: 99999 } }));
        const r = await new RipleyApiService().listListings(AUTH);
        expect(mockedGet).toHaveBeenCalledTimes(50);
        expect(r).toMatchObject({ productos: 5000, incompleto: true });
    });

    it('los pedidos de la consulta periódica se piden desde la fecha de actualización, en el formato de Ripley', async () => {
        mockedGet.mockResolvedValue({ data: { orders: [pedido('A-1', '2026-10-15T12:00:00Z')], total_count: 1 } });
        const r = await new RipleyApiService().listOrders(AUTH, { updatedFrom: new Date('2026-10-14T10:20:30.999Z'), max: 250 });

        expect(mockedGet.mock.calls[0][0]).toBe('https://ripleyperu-prod.mirakl.net/api/orders');
        expect(mockedGet.mock.calls[0][1].params).toMatchObject({ paginate: true, max: 100, offset: 0, start_update_date: '2026-10-14T10:20:30' });
        expect(mockedGet.mock.calls[0][1].params.end_update_date).toBeUndefined();
        expect(r.orders.map((o) => o.externalId)).toEqual(['A-1']);
        expect(r.incompleto).toBe(false);
    });

    it('el historial filtra por fecha de CREACIÓN (con un día de margen en la consulta) y ordena de lo más nuevo a lo más viejo', async () => {
        mockedGet.mockResolvedValue({ data: { orders: [pedido('VIEJO', '2026-09-01T00:00:00Z'), pedido('B-1', '2026-10-05T10:00:00Z'), pedido('B-2', '2026-10-20T10:00:00Z'), pedido('FUTURO', '2026-12-01T00:00:00Z')], total_count: 4 } });
        const r = await new RipleyApiService().listOrders(AUTH, { createdFrom: new Date('2026-10-01T00:00:00Z'), createdTo: new Date('2026-10-31T23:59:59Z'), max: 600 });

        expect(mockedGet.mock.calls[0][1].params).toMatchObject({ start_update_date: '2026-09-30T00:00:00', end_update_date: '2026-11-01T23:59:59' });
        expect(r.orders.map((o) => o.externalId)).toEqual(['B-2', 'B-1']);
    });

    it('pagina los pedidos y respeta el tope', async () => {
        mockedGet.mockImplementation(async (_u: string, o: any) => ({ data: { orders: Array.from({ length: 100 }, (_, i) => pedido(`P-${o.params.offset + i}`, '2026-10-15T12:00:00Z')), total_count: 5000 } }));
        const r = await new RipleyApiService().listOrders(AUTH, { updatedFrom: new Date(), max: 250 });
        expect(r.orders).toHaveLength(250);
        expect(r.incompleto).toBe(true);
    });

    it('sin SKU no escribe en Ripley: da un error claro y no llama a nadie', async () => {
        await expect(new RipleyApiService().setInventory(AUTH, { externalId: '1', variationId: null }, { stock: 1 })).rejects.toThrow(/Falta el SKU/);
        expect(mockedGet).not.toHaveBeenCalled();
        expect((axios as any).post).not.toHaveBeenCalled();
    });
});

describe('Ripley: mensajes de error', () => {
    it('cada caso dice qué pasó y qué hacer', () => {
        expect(describirErrorRipley({ response: { status: 401 } })).toMatch(/clave/);
        expect(describirErrorRipley({ response: { status: 403 } })).toMatch(/permisos|cerrada/);
        expect(describirErrorRipley({ response: { status: 404 } })).toMatch(/dirección/);
        expect(describirErrorRipley({ response: { status: 429 } })).toMatch(/limitó/);
        expect(describirErrorRipley({ response: { status: 503 } })).toMatch(/problema en este momento/);
        expect(describirErrorRipley({ response: { status: 302 } })).toMatch(/redirigió/);
        expect(describirErrorRipley({ response: { status: 200, data: '<html>login</html>' } })).toMatch(/página web/);
        expect(describirErrorRipley({ code: 'ENOTFOUND' })).toMatch(/No se pudo contactar con Ripley \(ENOTFOUND\)/);
        expect(describirErrorRipley({ response: { status: 400, data: { message: 'fecha inválida' } } })).toMatch(/fecha inválida/);
    });
});
