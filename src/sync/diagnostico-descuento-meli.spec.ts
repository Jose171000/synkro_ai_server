import { NotFoundException } from '@nestjs/common';
import { SyncService } from './sync.service';

const SCOPE = { userId: 'u1', storeId: 's1' };

function armar(item: any | null, vendedor: any, promociones: any[] = []) {
    const svc: any = Object.create(SyncService.prototype);
    svc.listingLinkRepository = { findOne: jest.fn(async () => ({ id: 'l1', externalId: 'MPE1', connection: { id: 'c1' }, product: { id: 'p1' } })) };
    svc.getValidConnectionById = jest.fn(async () => ({ accessToken: 'tok', externalUserId: '999' }));
    svc.meliApi = {
        getItems: jest.fn(async () => ({ items: item ? [item] : [], notFound: item ? [] : ['MPE1'] })),
        getSellerInfo: jest.fn(async () => vendedor),
        getItemPromotions: jest.fn(async () => promociones),
    };
    return svc;
}
const bueno = { id: 'MPE1', status: 'active', condition: 'new', listing_type_id: 'gold_special', sold_quantity: 12, price: 350, available_quantity: 5 };
const verde = { id: 999, nickname: 'AMERICATEX', seller_reputation: { level_id: '5_green', power_seller_status: 'silver', transactions: { completed: 100, total: 110 } } };

describe('diagnóstico de descuento de Mercado Libre (solo lectura)', () => {
    it('una publicación sana con reputación verde no marca motivos claros y lista las promociones', async () => {
        const svc = armar(bueno, verde, [{ type: 'PRICE_DISCOUNT', status: 'started' }]);
        const r = await svc.diagnosticoDeDescuentoMeli(SCOPE, 'l1');
        expect(r.vendedor).toMatchObject({ reputacion: '5_green', ventasCompletadas: 100 });
        expect(r.publicacion).toMatchObject({ estado: 'active', exposicion: 'gold_special', vendidos: 12 });
        expect(r.promociones).toEqual([{ type: 'PRICE_DISCOUNT', status: 'started' }]);
        expect(r.hallazgos).toEqual([expect.stringMatching(/No se ve un motivo claro/)]);
    });

    it('señala reputación que no es verde, exposición gratuita, sin ventas y estado no activo', async () => {
        const svc = armar({ ...bueno, status: 'paused', listing_type_id: 'free', sold_quantity: 0, condition: 'used' }, { id: 999, seller_reputation: { level_id: '3_yellow' } });
        const r = await svc.diagnosticoDeDescuentoMeli(SCOPE, 'l1');
        const texto = r.hallazgos.join(' | ');
        expect(texto).toMatch(/3_yellow/);
        expect(texto).toMatch(/estado «paused»/);
        expect(texto).toMatch(/condición es «used»/);
        expect(texto).toMatch(/exposición gratuita/);
        expect(texto).toMatch(/no tiene ventas/);
    });

    it('una cuenta sin nivel de reputación se avisa', async () => {
        const r = await armar(bueno, { id: 999, seller_reputation: {} }).diagnosticoDeDescuentoMeli(SCOPE, 'l1');
        expect(r.hallazgos.join(' ')).toMatch(/no tiene nivel de reputación/);
    });

    it('si Mercado Libre falla al leer la reputación o las promociones, se informa en vez de romper', async () => {
        const svc = armar(bueno, verde);
        svc.meliApi.getSellerInfo.mockRejectedValueOnce(new Error('403 sin permiso'));
        svc.meliApi.getItemPromotions.mockRejectedValueOnce(new Error('403 Resource deprecated'));
        const r = await svc.diagnosticoDeDescuentoMeli(SCOPE, 'l1');
        expect(r.vendedor).toMatchObject({ error: expect.stringContaining('403') });
        expect(r.promociones[0]).toMatchObject({ error: expect.stringContaining('deprecated') });
    });

    it('una publicación que Mercado Libre ya no tiene, o que no es de esta tienda, se explica o da 404', async () => {
        const r = await armar(null, verde).diagnosticoDeDescuentoMeli(SCOPE, 'l1');
        expect(r.publicacion).toBeNull();
        expect(r.hallazgos[0]).toMatch(/ya no existe/);
        const svc = armar(bueno, verde);
        svc.listingLinkRepository.findOne.mockResolvedValueOnce(null);
        await expect(svc.diagnosticoDeDescuentoMeli(SCOPE, 'otra')).rejects.toThrow(NotFoundException);
    });
});
