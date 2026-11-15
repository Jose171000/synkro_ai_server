import { BadRequestException } from '@nestjs/common';
import { SyncService } from './sync.service';

/** Descuento propio de UNA cuenta (Falabella, Mercado Libre o WooCommerce): queda en su publicación y se envía solo a ella. */
const SCOPE = { userId: 'u1', storeId: 's1' };

function armar(marketplace: string, over: any = {}, revision = false) {
    const svc: any = Object.create(SyncService.prototype);
    const producto: any = { id: 'p1', sku: 'SKU-1', price: 350, salePrice: null };
    const enlace: any = { id: 'l1', marketplace, syncStatus: 'published', pausedByUser: false, priceOverride: null, salePriceOverride: null, saleStartOverride: null, saleEndOverride: null, connection: { id: 'c1' }, product: { id: 'p1' }, ...over };
    svc.listingLinkRepository = { findOne: jest.fn(async () => enlace), save: jest.fn(async (e: any) => e) };
    svc.findScopedProduct = jest.fn(async () => producto);
    svc.changeRequests = { isReviewMode: jest.fn(async () => revision), createPromoRequest: jest.fn(async () => ({})) };
    svc.syncQueue = { add: jest.fn() };
    return { svc, enlace, producto };
}

describe('descuento propio de una cuenta (setListingPromo)', () => {
    it('Mercado Libre: se guarda en esa publicación, sin tocar el producto, y se envía solo a esa cuenta', async () => {
        const { svc, enlace, producto } = armar('mercadolibre');
        const r = await svc.setListingPromo(SCOPE, 'l1', { salePrice: 165, saleStart: '2026-11-14', saleEnd: '2026-11-24' });
        expect(enlace.salePriceOverride).toBe(165);
        expect(enlace.saleEndOverride).toBe('2026-11-24');
        expect(producto.salePrice).toBeNull();
        expect(svc.syncQueue.add).toHaveBeenCalledTimes(1);
        expect(svc.syncQueue.add).toHaveBeenCalledWith('inventory', expect.objectContaining({ marketplace: 'mercadolibre', connectionId: 'c1' }));
        expect(r.message).toMatch(/enviado a Mercado Libre/);
    });

    it('Mercado Libre y WooCommerce exigen fecha de fin; el precio debe ser menor que el regular', async () => {
        const ml = armar('mercadolibre');
        await expect(ml.svc.setListingPromo(SCOPE, 'l1', { salePrice: 165 })).rejects.toThrow(/fecha de fin/);
        await expect(ml.svc.setListingPromo(SCOPE, 'l1', { salePrice: 400, saleEnd: '2026-11-24' })).rejects.toThrow(/menor que el precio regular en Mercado Libre/);
        const woo = armar('woocommerce');
        await expect(woo.svc.setListingPromo(SCOPE, 'l1', { salePrice: 165 })).rejects.toThrow(BadRequestException);
        expect(ml.svc.syncQueue.add).not.toHaveBeenCalled();
    });

    it('usa el precio propio de la cuenta como base cuando lo tiene', async () => {
        const { svc } = armar('woocommerce', { priceOverride: 200 });
        await expect(svc.setListingPromo(SCOPE, 'l1', { salePrice: 250, saleEnd: '2026-11-24' })).rejects.toThrow(/\(200\.00\)/);
        await expect(svc.setListingPromo(SCOPE, 'l1', { salePrice: 150, saleEnd: '2026-11-24' })).resolves.toBeDefined();
    });

    it('con el modo revisión crea una solicitud de ESA cuenta y no guarda ni envía nada', async () => {
        const { svc, enlace } = armar('mercadolibre', {}, true);
        const r = await svc.setListingPromo(SCOPE, 'l1', { salePrice: 165, saleStart: '2026-11-14', saleEnd: '2026-11-24' });
        expect(svc.changeRequests.createPromoRequest).toHaveBeenCalledWith(SCOPE, expect.anything(), expect.objectContaining({ marketplace: 'mercadolibre', connectionId: 'c1', next: '165|2026-11-14|2026-11-24' }));
        expect(enlace.salePriceOverride).toBeNull();
        expect(svc.syncQueue.add).not.toHaveBeenCalled();
        expect(r).toMatchObject({ pending: 1 });
        expect(r.message).toMatch(/para mandarlo a Mercado Libre/);
    });

    it('quitar el descuento propio en WooCommerce lo borra y manda el envío que lo retira; en Falabella no manda nada', async () => {
        const woo = armar('woocommerce', { salePriceOverride: 165, saleStartOverride: '2026-11-14', saleEndOverride: '2026-11-24' });
        const r = await woo.svc.setListingPromo(SCOPE, 'l1', { salePrice: null });
        expect(woo.enlace.salePriceOverride).toBeNull();
        expect(woo.enlace.saleEndOverride).toBeNull();
        expect(woo.svc.syncQueue.add).toHaveBeenCalledWith('inventory', expect.objectContaining({ marketplace: 'woocommerce' }));
        expect(r.message).toMatch(/se retira de WooCommerce/);

        const fala = armar('falabella', { salePriceOverride: 165 });
        const r2 = await fala.svc.setListingPromo(SCOPE, 'l1', { salePrice: null });
        expect(fala.svc.syncQueue.add).not.toHaveBeenCalled();
        expect(r2.message).toMatch(/Seller Center/);
    });

    it('Falabella sigue aceptando un descuento sin fecha de fin (lo ya cargado)', async () => {
        const { svc, enlace } = armar('falabella');
        await svc.setListingPromo(SCOPE, 'l1', { salePrice: 165 });
        expect(enlace.salePriceOverride).toBe(165);
        expect(enlace.saleEndOverride).toBeNull();
    });

    it('un canal sin descuento por cuenta (p. ej. Shopify) se rechaza con un mensaje claro', async () => {
        const { svc } = armar('shopify');
        await expect(svc.setListingPromo(SCOPE, 'l1', { salePrice: 100, saleEnd: '2026-11-24' })).rejects.toThrow(/Falabella, Mercado Libre, WooCommerce y Ripley/);
    });
});
