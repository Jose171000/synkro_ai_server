import { SyncService } from './sync.service';

/**
 * Falabella rechaza con un 429 los feeds que se crean demasiado seguidos (1 cada 2 minutos y/o 50 a la vez). Un lote manda
 * varios productos en UN feed de precio y UN feed de stock, y si Falabella pide esperar, esos productos no se dan por enviados.
 */
const enlace = (sku: string, over: any = {}, productoOver: any = {}) => ({
    marketplace: 'falabella', syncStatus: 'published', pausedByUser: false,
    lastPriceSynced: 250, lastStockSynced: 5, lastPromoSynced: null, salePriceOverride: null,
    product: { id: `id-${sku}`, sku, price: 300, stock: 5, ...productoOver },
    connection: { id: 'c1', owner: { id: 'u1' } },
    ...over,
});

function armar(enlaces: any[], api: Partial<Record<'updatePrices' | 'updateStock', jest.Mock>> = {}) {
    const s: any = Object.create(SyncService.prototype);
    s.listingLinkRepository = { find: jest.fn(async () => enlaces), save: jest.fn(async (x: any) => x) };
    s.falabellaApi = {
        updatePrices: api.updatePrices ?? jest.fn(async () => 'feed-precio'),
        updateStock: api.updateStock ?? jest.fn(async () => 'feed-stock'),
    };
    s.getFalabellaCredentials = jest.fn(async () => ({ userId: 'x', apiKey: 'y' }));
    s.registrarFeedFalabella = jest.fn(async () => 'ok');
    s.describeApiError = (e: any) => String(e?.message ?? e);
    return s;
}

describe('Falabella: precios y stock por lotes', () => {
    it('varios productos con precio nuevo salen en UN solo feed de precio', async () => {
        const enlaces = [enlace('A-1'), enlace('A-2'), enlace('A-3')];
        const s = armar(enlaces);
        const r = await s.pushInventoryLoteFalabella(enlaces.map((e) => e.product.id), 'c1');
        expect(s.falabellaApi.updatePrices).toHaveBeenCalledTimes(1);
        expect(s.falabellaApi.updatePrices.mock.calls[0][1].map((i: any) => i.sellerSku)).toEqual(['A-1', 'A-2', 'A-3']);
        expect(s.falabellaApi.updateStock).not.toHaveBeenCalled(); // el stock no cambió
        expect(s.registrarFeedFalabella).toHaveBeenCalledWith('u1', 'c1', 'ProductUpdate', ['A-1', 'A-2', 'A-3'], 'feed-precio');
        expect([...r.porProducto.values()].every((x: any) => x.status === 'enviado')).toBe(true);
        expect(r.limitado).toBe(false);
        expect(enlaces.every((e) => e.lastPriceSynced === 300)).toBe(true); // queda anotado lo enviado
    });

    it('el stock que cambió va en un solo feed de stock, aparte del de precio', async () => {
        const enlaces = [enlace('A-1', { lastStockSynced: 9 }), enlace('A-2', { lastStockSynced: 9 })];
        const s = armar(enlaces);
        await s.pushInventoryLoteFalabella(enlaces.map((e) => e.product.id), 'c1');
        expect(s.falabellaApi.updateStock).toHaveBeenCalledTimes(1);
        expect(s.falabellaApi.updateStock.mock.calls[0][1]).toEqual([{ sellerSku: 'A-1', quantity: 5 }, { sellerSku: 'A-2', quantity: 5 }]);
    });

    it('un producto que ya está al día no se manda; el descuento viaja con su precio', async () => {
        const alDia = enlace('A-1', { lastPriceSynced: 300 });
        const conDescuento = enlace('A-2', { salePriceOverride: 198.95, saleStartOverride: '2026-11-20', saleEndOverride: '2027-11-20' });
        const s = armar([alDia, conDescuento]);
        const r = await s.pushInventoryLoteFalabella([alDia.product.id, conDescuento.product.id], 'c1');
        expect(r.porProducto.get(alDia.product.id)).toEqual({ status: 'sin-cambios' });
        const item = s.falabellaApi.updatePrices.mock.calls[0][1][0];
        expect(item).toMatchObject({ sellerSku: 'A-2', price: 300, salePrice: 198.95 });
    });

    it('si Falabella responde 429, esos productos NO se dan por enviados y no se anota nada como enviado', async () => {
        const enlaces = [enlace('A-1'), enlace('A-2')];
        const s = armar(enlaces, { updatePrices: jest.fn(async () => { throw new Error('Falabella rechazó la petición ProductUpdate: 429 Too many attempts to Create feeds.'); }) });
        const r = await s.pushInventoryLoteFalabella(enlaces.map((e) => e.product.id), 'c1');
        expect(r.limitado).toBe(true);
        expect([...r.porProducto.values()].every((x: any) => x.status === 'limitado')).toBe(true);
        expect(enlaces.every((e) => e.lastPriceSynced === 250)).toBe(true);
        expect(s.registrarFeedFalabella).not.toHaveBeenCalled();
    });

    it('otro error de Falabella marca los productos con error (y deja el motivo), sin pedir espera', async () => {
        const enlaces = [enlace('A-1')];
        const s = armar(enlaces, { updatePrices: jest.fn(async () => { throw new Error('SKU inválido'); }) });
        const r = await s.pushInventoryLoteFalabella([enlaces[0].product.id], 'c1');
        expect(r.limitado).toBe(false);
        expect(r.porProducto.get(enlaces[0].product.id)).toMatchObject({ status: 'error', message: 'SKU inválido' });
        expect(enlaces[0]).toMatchObject({ lastError: 'SKU inválido', lastPriceSynced: 250 });
    });

    it('un producto pausado o sin publicación en la cuenta no se envía', async () => {
        const pausado = enlace('A-1', { pausedByUser: true });
        const s = armar([pausado]);
        const r = await s.pushInventoryLoteFalabella([pausado.product.id, 'no-existe'], 'c1');
        expect(r.porProducto.get(pausado.product.id)).toEqual({ status: 'pausada' });
        expect(r.porProducto.get('no-existe')).toEqual({ status: 'omitido' });
        expect(s.falabellaApi.updatePrices).not.toHaveBeenCalled();
    });
});
