import { SyncService } from './sync.service';
import { hoyEnLima } from './descuento-general';

/** Mercado Libre responde «No candidates found for item» (p. ej. cuenta con reputación roja): se anota y no se insiste cada día. */
const enDias = (n: number) => new Date(Date.parse(`${hoyEnLima()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function armar() {
    const svc: any = Object.create(SyncService.prototype);
    svc.meliApi = { aplicarDescuento: jest.fn(), quitarDescuento: jest.fn() };
    svc.listingLinkRepository = { findOne: jest.fn(async () => null) };
    svc.describeApiError = (e: any) => String(e?.message ?? e);
    const producto: any = { id: 'p1', price: 350, salePrice: 165, saleStartDate: hoyEnLima(), saleEndDate: enDias(10) };
    const enlace: any = { id: 'l1', externalId: 'MPE1', variationId: null, lastPromoSynced: null, lastError: null, salePriceOverride: null };
    return { svc, producto, enlace };
}

describe('descuento de Mercado Libre rechazado por «No candidates found»', () => {
    const antes = { ...process.env };
    beforeEach(() => { process.env.MELI_PROMOS_ACTIVAS = 'true'; });
    afterEach(() => { process.env = { ...antes }; });

    it('se anota el rechazo con un mensaje claro y no se vuelve a pedir en los días siguientes', async () => {
        const { svc, producto, enlace } = armar();
        svc.meliApi.aplicarDescuento.mockRejectedValueOnce(new Error('Mercado Libre respondió 400: No candidates found for item'));
        await svc.sincronizarDescuentoMeli('tok', enlace, producto, 350);
        expect(enlace.lastPromoSynced).toMatch(/^x\|165\|/);
        expect(enlace.lastError).toMatch(/no es candidata a descuentos/);
        expect(enlace.lastError).toMatch(/reputación de la cuenta/);

        // Otro envío de stock/precio (que limpia el error) vuelve a pasar por aquí: no se insiste y el aviso se mantiene.
        enlace.lastError = null;
        svc.meliApi.aplicarDescuento.mockClear();
        await svc.sincronizarDescuentoMeli('tok', enlace, producto, 350);
        expect(svc.meliApi.aplicarDescuento).not.toHaveBeenCalled();
        expect(svc.meliApi.quitarDescuento).not.toHaveBeenCalled();
        expect(enlace.lastError).toMatch(/no es candidata a descuentos/);
    });

    it('un descuento aplicado deja anotado el precio con descuento (el tablero lo muestra tachado) y el rechazo lo limpia', async () => {
        const { svc, producto, enlace } = armar();
        svc.meliApi.aplicarDescuento.mockResolvedValueOnce(undefined);
        await svc.sincronizarDescuentoMeli('tok', enlace, producto, 350);
        expect(enlace.salePrice).toBe(165);
        // Un cambio que Mercado Libre rechaza deja la publicación sin descuento anotado.
        producto.salePrice = 200;
        svc.meliApi.aplicarDescuento.mockRejectedValueOnce(new Error('No candidates found for item'));
        await svc.sincronizarDescuentoMeli('tok', enlace, producto, 350);
        expect(enlace.salePrice).toBeNull();
        // Quitar el descuento también lo limpia.
        const otra = armar();
        otra.enlace.lastPromoSynced = `165|${enDias(-2)}|${enDias(5)}`;
        otra.enlace.salePrice = 165;
        otra.producto.salePrice = null;
        await otra.svc.sincronizarDescuentoMeli('tok', otra.enlace, otra.producto, 350);
        expect(otra.svc.meliApi.quitarDescuento).toHaveBeenCalled();
        expect(otra.enlace.salePrice).toBeNull();
    });

    it('una promoción ya puesta que sigue en curso anota su precio en cada envío, sin volver a pedirla a Mercado Libre', async () => {
        const { svc, producto, enlace } = armar();
        enlace.lastPromoSynced = `165|${enDias(-1)}|${enDias(10)}`;
        producto.saleStartDate = enDias(-1);
        enlace.salePrice = null;
        await svc.sincronizarDescuentoMeli('tok', enlace, producto, 350);
        expect(svc.meliApi.aplicarDescuento).not.toHaveBeenCalled();
        expect(enlace.salePrice).toBe(165);
    });

    it('la lectura del listado no borra el aviso de «no es candidata a descuentos» mientras el rechazo siga anotado', () => {
        const { svc, enlace } = armar();
        enlace.lastPromoSynced = `x|165|${enDias(-1)}|${enDias(9)}|${enDias(0)}`;
        const fila = { externalId: 'MPE1', variationId: null, permalink: null, status: 'published', stock: 10, regularPrice: 350, salePrice: null, imageUrl: null, variation: null, quality: null };
        svc.aplicarFilaMeli(enlace, fila);
        expect(enlace.lastError).toMatch(/no es candidata a descuentos/);
        // Sin rechazo anotado, la lectura limpia el error como siempre.
        enlace.lastPromoSynced = null;
        svc.aplicarFilaMeli(enlace, fila);
        expect(enlace.lastError).toBeNull();
        // Un bloqueo real de la publicación sigue mostrándose.
        svc.aplicarFilaMeli(enlace, { ...fila, status: 'error' });
        expect(enlace.lastError).toMatch(/bloqueó o suspendió/);
    });

    it('si el descuento se quita, el rechazo anotado y su aviso se limpian en el siguiente envío', async () => {
        const { svc, producto, enlace } = armar();
        svc.meliApi.aplicarDescuento.mockRejectedValueOnce(new Error('No candidates found for item'));
        await svc.sincronizarDescuentoMeli('tok', enlace, producto, 350);
        expect(enlace.lastError).toMatch(/no es candidata/);
        producto.salePrice = null;
        enlace.lastError = null;
        await svc.sincronizarDescuentoMeli('tok', enlace, producto, 350);
        expect(enlace.lastPromoSynced).toBeNull();
        expect(enlace.lastError).toBeNull();
        expect(svc.meliApi.quitarDescuento).not.toHaveBeenCalled();
    });

    it('otro error de Mercado Libre no se anota como rechazo: se reintenta y se muestra tal cual', async () => {
        const { svc, producto, enlace } = armar();
        svc.meliApi.aplicarDescuento.mockRejectedValueOnce(new Error('timeout'));
        await svc.sincronizarDescuentoMeli('tok', enlace, producto, 350);
        expect(enlace.lastPromoSynced).toBeNull();
        expect(enlace.lastError).toBe('Descuento no aplicado en Mercado Libre: timeout');
    });

    it('si cambia el descuento, se vuelve a intentar enseguida', async () => {
        const { svc, producto, enlace } = armar();
        svc.meliApi.aplicarDescuento.mockRejectedValueOnce(new Error('No candidates found for item'));
        await svc.sincronizarDescuentoMeli('tok', enlace, producto, 350);
        producto.salePrice = 200;
        svc.meliApi.aplicarDescuento.mockResolvedValueOnce(undefined);
        await svc.sincronizarDescuentoMeli('tok', enlace, producto, 350);
        expect(svc.meliApi.aplicarDescuento).toHaveBeenCalledTimes(2);
        expect(svc.meliApi.aplicarDescuento).toHaveBeenLastCalledWith('tok', 'MPE1', expect.objectContaining({ dealPrice: 200 }));
        expect(enlace.lastPromoSynced).toMatch(/^200\|/);
    });
});
