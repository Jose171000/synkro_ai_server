import { SyncService } from './sync.service';

/**
 * Descuento general con el modo revisión activo: cada cuenta de Falabella, Mercado Libre, WooCommerce y Ripley pide SU aprobación,
 * y mientras tanto no se guarda ni se envía nada (nada llega a un canal sin su aprobación).
 */
const SCOPE = { userId: 'u1', storeId: 's1' };

function armar(enlaces: any[], opciones: { revision?: boolean } = {}) {
    const svc: any = Object.create(SyncService.prototype);
    const producto: any = { id: 'p1', sku: 'SKU-1', price: 350, salePrice: null };
    svc.findScopedProduct = jest.fn(async () => producto);
    svc.productRepository = { save: jest.fn(async (p: any) => p) };
    svc.listingLinkRepository = {
        find: jest.fn(async ({ where }: any) => enlaces.filter((e) => {
            const mp = where.marketplace;
            const lista: string[] = mp?._value ?? (mp ? [mp] : []);
            return lista.includes(e.marketplace);
        })),
        count: jest.fn(async ({ where }: any) => enlaces.filter((e) => e.marketplace === where.marketplace).length),
    };
    svc.changeRequests = { isReviewMode: jest.fn(async () => opciones.revision ?? true), createPromoRequest: jest.fn(async () => ({})) };
    svc.syncQueue = { add: jest.fn() };
    return { svc, producto };
}

const enlace = (marketplace: string, conn: string, over: any = {}) => ({ id: `l-${conn}`, marketplace, connection: { id: conn }, syncStatus: 'published', pausedByUser: false, salePrice: null, regularPrice: 350, ...over });

describe('descuento general con el modo revisión', () => {
    const antes = { ...process.env };
    afterEach(() => { process.env = { ...antes }; });

    it('crea una solicitud por cada cuenta de Falabella, Mercado Libre y WooCommerce, sin guardar ni enviar nada', async () => {
        const { svc, producto } = armar([enlace('falabella', 'cf'), enlace('mercadolibre', 'cm1'), enlace('mercadolibre', 'cm2'), enlace('woocommerce', 'cw')]);
        const r = await svc.setPromo(SCOPE, 'p1', { salePrice: 165, saleStartDate: '2026-11-14', saleEndDate: '2026-11-24' });
        const pedidas = svc.changeRequests.createPromoRequest.mock.calls.map((c: any[]) => `${c[2].marketplace}:${c[2].connectionId}`).sort();
        expect(pedidas).toEqual(['falabella:cf', 'mercadolibre:cm1', 'mercadolibre:cm2', 'woocommerce:cw']);
        // El valor no lleva la marca «general»: lo aprobado queda solo en la cuenta de la solicitud.
        expect(svc.changeRequests.createPromoRequest.mock.calls[0][2].next).not.toMatch(/\|g$/);
        expect(svc.productRepository.save).not.toHaveBeenCalled();
        expect(svc.syncQueue.add).not.toHaveBeenCalled();
        expect(producto.salePrice).toBeNull();
        expect(r).toMatchObject({ pending: 4 });
        expect(r.message).toMatch(/4 solicitud/);
    });

    it('Ripley también pide aprobación (si su envío de precios está habilitado y el descuento queda bajo su precio de lista)', async () => {
        process.env.RIPLEY_PUSH_ENABLED = 'true';
        process.env.RIPLEY_PUSH_PRICE = 'true';
        process.env.RIPLEY_PUSH_SKUS = '*';
        const { svc } = armar([enlace('mercadolibre', 'cm'), enlace('ripley', 'cr', { regularPrice: 350 })]);
        const r = await svc.setPromo(SCOPE, 'p1', { salePrice: 165, saleEndDate: '2026-11-24' });
        const pedidas = svc.changeRequests.createPromoRequest.mock.calls.map((c: any[]) => c[2].marketplace).sort();
        expect(pedidas).toEqual(['mercadolibre', 'ripley']);
        expect(svc.syncQueue.add).not.toHaveBeenCalled();
        expect(r.pending).toBe(2);
    });

    it('Ripley sin su envío habilitado no crea solicitud y se explica', async () => {
        delete process.env.RIPLEY_PUSH_ENABLED;
        const { svc } = armar([enlace('mercadolibre', 'cm'), enlace('ripley', 'cr')]);
        const r = await svc.setPromo(SCOPE, 'p1', { salePrice: 165, saleEndDate: '2026-11-24' });
        expect(svc.changeRequests.createPromoRequest.mock.calls.map((c: any[]) => c[2].marketplace)).toEqual(['mercadolibre']);
        expect(r.message).toMatch(/Ripley no recibió el descuento/);
    });

    it('un producto que solo está en Ripley también espera aprobación (no se salta la revisión)', async () => {
        process.env.RIPLEY_PUSH_ENABLED = 'true';
        process.env.RIPLEY_PUSH_PRICE = 'true';
        process.env.RIPLEY_PUSH_SKUS = '*';
        const { svc } = armar([enlace('ripley', 'cr', { regularPrice: 350 })]);
        const r = await svc.setPromo(SCOPE, 'p1', { salePrice: 165, saleEndDate: '2026-11-24' });
        expect(svc.changeRequests.createPromoRequest).toHaveBeenCalledTimes(1);
        expect(svc.syncQueue.add).not.toHaveBeenCalled();
        expect(r.pending).toBe(1);
    });

    it('quitar el descuento también pide aprobación por cuenta', async () => {
        const { svc } = armar([enlace('mercadolibre', 'cm', { salePrice: 165 }), enlace('woocommerce', 'cw')]);
        const r = await svc.setPromo(SCOPE, 'p1', { salePrice: null });
        expect(svc.changeRequests.createPromoRequest).toHaveBeenCalledTimes(2);
        expect(svc.changeRequests.createPromoRequest.mock.calls[0][2].next).toBe('quitar');
        expect(r.message).toMatch(/Quitar el descuento quedó en revisión/);
    });

    it('sin el modo revisión, el descuento se guarda y se manda como siempre', async () => {
        const { svc, producto } = armar([enlace('mercadolibre', 'cm')], { revision: false });
        await svc.setPromo(SCOPE, 'p1', { salePrice: 165, saleStartDate: '2026-11-14', saleEndDate: '2026-11-24' });
        expect(svc.changeRequests.createPromoRequest).not.toHaveBeenCalled();
        expect(producto.salePrice).toBe(165);
        expect(svc.syncQueue.add).toHaveBeenCalledWith('inventory', expect.objectContaining({ marketplace: 'mercadolibre', connectionId: 'cm' }));
    });
});
