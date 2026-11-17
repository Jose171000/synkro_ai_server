import { SyncService } from './sync.service';

const hace = (min: number) => new Date(Date.now() - min * 60_000);
const foto = (u: string) => ({ url: u });

function armar(enlaces: any[], fichas: any[]) {
    const svc: any = Object.create(SyncService.prototype);
    svc.ultimoReenvioDeFotos = new Map();
    svc.listingLinkRepository = { find: jest.fn(async () => enlaces), save: jest.fn(async (e: any) => e) };
    svc.productRepository = { update: jest.fn(async () => undefined) };
    svc.getValidConnectionById = jest.fn(async () => ({ id: 'c1' }));
    svc.credentialsOf = jest.fn(() => ({ userId: 'u', apiKey: 'k' }));
    svc.falabellaApi = { getProductsBySku: jest.fn(async () => fichas) };
    svc.enviarImagenesAFalabella = jest.fn(async () => undefined);
    return svc;
}
const enlace = (sku: string, over: any = {}, productoOver: any = {}) => ({
    id: `l-${sku}`, syncStatus: 'pending', createdAt: hace(30), lastError: null,
    product: { id: `p-${sku}`, sku, images: [foto('https://c/a.jpg')], aiAttributes: {}, ...productoOver },
    connection: { owner: { id: 'u1' } }, ...over,
});
const ficha = (sku: string, imagenes: string[] = []) => ({ SellerSku: sku, MainImage: imagenes[0], Images: { Image: imagenes.slice(1) } });

describe('Falabella: comprobar que cada ficha tenga sus fotos', () => {
    beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
    afterEach(() => jest.restoreAllMocks());

    it('una ficha que ya tiene fotos se anota como comprobada y no se reenvía nada', async () => {
        const svc = armar([enlace('A')], [ficha('A', ['https://f/1.jpg'])]);
        expect(await svc.verificarFotosDeFalabella('c1')).toEqual({ revisadas: 1, reenviadas: 0 });
        expect(svc.enviarImagenesAFalabella).not.toHaveBeenCalled();
        expect(svc.productRepository.update).toHaveBeenCalledWith('p-A', { aiAttributes: expect.objectContaining({ _fotosVerificadas: true }) });
    });

    it('una ficha sin fotos en Falabella recibe el reenvío solo, y queda anotado', async () => {
        const svc = armar([enlace('A')], [ficha('A')]);
        expect(await svc.verificarFotosDeFalabella('c1')).toEqual({ revisadas: 1, reenviadas: 1 });
        expect(svc.enviarImagenesAFalabella).toHaveBeenCalledTimes(1);
        expect(svc.productRepository.update).toHaveBeenCalledWith('p-A', { aiAttributes: expect.objectContaining({ _fotosReenvio: expect.objectContaining({ veces: 1 }) }) });
    });

    it('varias sin fotos salen en UN solo envío', async () => {
        const svc = armar([enlace('A'), enlace('B')], [ficha('A'), ficha('B')]);
        expect((await svc.verificarFotosDeFalabella('c1')).reenviadas).toBe(2);
        expect(svc.enviarImagenesAFalabella).toHaveBeenCalledTimes(1);
    });

    it('no toca las muy recientes (Falabella necesita unos minutos), las ya comprobadas ni las que no tienen fotos en Synkro', async () => {
        const svc = armar([
            enlace('A', { createdAt: hace(3) }),
            enlace('B', {}, { aiAttributes: { _fotosVerificadas: true } }),
            enlace('C', {}, { images: [] }),
        ], []);
        expect(await svc.verificarFotosDeFalabella('c1')).toEqual({ revisadas: 0, reenviadas: 0 });
        expect(svc.falabellaApi.getProductsBySku).not.toHaveBeenCalled();
    });

    it('si la ficha aún no existe en Falabella no hace nada', async () => {
        const svc = armar([enlace('A')], []);
        expect(await svc.verificarFotosDeFalabella('c1')).toEqual({ revisadas: 0, reenviadas: 0 });
        expect(svc.enviarImagenesAFalabella).not.toHaveBeenCalled();
    });

    it('respeta la espera de 30 min entre reenvíos del mismo producto', async () => {
        const reciente = { _fotosReenvio: { ultima: hace(5).toISOString(), veces: 1 } };
        const svc = armar([enlace('A', {}, { aiAttributes: reciente })], [ficha('A')]);
        expect((await svc.verificarFotosDeFalabella('c1')).reenviadas).toBe(0);
        expect(svc.enviarImagenesAFalabella).not.toHaveBeenCalled();
    });

    it('tras los 5 reenvíos sin resultado se rinde y deja el motivo en la publicación', async () => {
        const agotado = { _fotosReenvio: { ultima: hace(120).toISOString(), veces: 5 } };
        const e = enlace('A', {}, { aiAttributes: agotado });
        const svc = armar([e], [ficha('A')]);
        expect((await svc.verificarFotosDeFalabella('c1')).reenviadas).toBe(0);
        expect(svc.enviarImagenesAFalabella).not.toHaveBeenCalled();
        expect(e).toMatchObject({ syncStatus: 'error', lastError: expect.stringMatching(/sigue sin las fotos/) });
    });

    it('respeta la pausa entre peticiones de la misma cuenta', async () => {
        const svc = armar([enlace('A')], [ficha('A')]);
        svc.ultimoReenvioDeFotos.set('c1', Date.now());
        expect((await svc.verificarFotosDeFalabella('c1')).reenviadas).toBe(0);
        expect(svc.enviarImagenesAFalabella).not.toHaveBeenCalled();
    });
});
