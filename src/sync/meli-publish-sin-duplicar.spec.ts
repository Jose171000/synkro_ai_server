import { SyncService } from './sync.service';

/** Un SyncService con solo lo que usa la publicación en Mercado Libre. */
function construir(opts: { link?: any; idsPorSku?: string[]; items?: any[] } = {}) {
    const producto: any = { id: 'p1', sku: 'OG310', name: 'Zapatera', stock: 12, price: '39.90', aiDescription: '<p>Con <b>5</b> cajones</p>', aiAttributes: { brand: 'GENERICO' }, marketplaceIds: {} };
    const guardados: any[] = [];
    const meliApi: any = {
        findItemIdsBySku: jest.fn(async () => opts.idsPorSku ?? []),
        getItems: jest.fn(async (_t: string, ids: string[]) => ({ items: opts.items ?? ids.map((id) => ({ id, status: 'active', seller_id: 'u1', permalink: `https://ml/${id}` })), notFound: [] })),
        createItem: jest.fn(async () => ({ id: 'MPE-NUEVA', permalink: 'https://ml/nueva' })),
        setItemDescription: jest.fn(async () => undefined),
        updateItemDescription: jest.fn(async () => undefined),
        updateItemAttributes: jest.fn(async () => undefined),
        updateItem: jest.fn(async () => undefined),
        predictCategory: jest.fn(async () => 'MPE124007'),
    };
    const svc: any = Object.create(SyncService.prototype);
    svc.productRepository = { findOne: jest.fn(async () => producto), save: jest.fn(async (p: any) => p) };
    svc.listingLinkRepository = {
        findOne: jest.fn(async () => opts.link ?? null),
        create: jest.fn((x: any) => x),
        save: jest.fn(async (l: any) => { guardados.push({ ...l }); return l; }),
    };
    svc.meliApi = meliApi;
    svc.notifications = { notify: jest.fn(async () => undefined) };
    svc.getValidConnectionById = jest.fn(async () => ({ id: 'c1', accessToken: 'tok', externalUserId: 'u1', marketplace: 'mercadolibre' }));
    return { svc: svc as SyncService, meliApi, producto, guardados };
}

describe('Mercado Libre: no se vuelve a crear una publicación que ya existe', () => {
    it('sin publicación previa la crea, anota el id antes de la descripción y manda la descripción en texto plano', async () => {
        const { svc, meliApi, guardados } = construir();
        const link = await svc.publishToMeli('p1', 'u', 'c1');

        expect(meliApi.createItem).toHaveBeenCalledTimes(1);
        const attrs = meliApi.createItem.mock.calls[0][1].attributes;
        expect(attrs).toContainEqual({ id: 'SELLER_SKU', value_name: 'OG310' });
        expect(meliApi.setItemDescription).toHaveBeenCalledWith('tok', 'MPE-NUEVA', 'Con 5 cajones');
        expect(guardados[0].externalId).toBe('MPE-NUEVA'); // se anotó antes de seguir
        expect(link.syncStatus).toBe('published');
    });

    it('si Mercado Libre ya tiene una publicación con ese SKU no crea otra: la enlaza y la actualiza', async () => {
        const { svc, meliApi, producto } = construir({ idsPorSku: ['MPE111'] });
        const link = await svc.publishToMeli('p1', 'u', 'c1');

        expect(meliApi.createItem).not.toHaveBeenCalled();
        expect(meliApi.updateItemDescription).toHaveBeenCalledWith('tok', 'MPE111', 'Con 5 cajones');
        expect(meliApi.updateItem).toHaveBeenCalledWith('tok', 'MPE111', { available_quantity: 12, price: 39.9 });
        expect(link.externalId).toBe('MPE111');
        expect(link.syncStatus).toBe('published');
        expect(producto.marketplaceIds.mercadolibre).toBe('MPE111');
    });

    it('si el enlace ya tiene el id de un intento a medias, lo actualiza en vez de crear otra', async () => {
        const link: any = { marketplace: 'mercadolibre', externalId: 'MPE222', syncStatus: 'error', lastError: 'x' };
        const { svc, meliApi } = construir({ link });
        const r = await svc.publishToMeli('p1', 'u', 'c1');

        expect(meliApi.createItem).not.toHaveBeenCalled();
        expect(meliApi.findItemIdsBySku).not.toHaveBeenCalled();
        expect(r.externalId).toBe('MPE222');
        expect(r.syncStatus).toBe('published');
        expect(r.lastError).toBeNull();
    });

    it('una publicación cerrada con ese SKU no cuenta: se crea una nueva', async () => {
        const { svc, meliApi } = construir({ idsPorSku: ['MPE333'], items: [{ id: 'MPE333', status: 'closed', seller_id: 'u1' }] });
        await svc.publishToMeli('p1', 'u', 'c1');
        expect(meliApi.createItem).toHaveBeenCalledTimes(1);
    });

    it('si falla algo al actualizar la existente no la pierde: queda enlazada con el aviso', async () => {
        const { svc, meliApi } = construir({ idsPorSku: ['MPE111'] });
        meliApi.updateItemAttributes.mockRejectedValueOnce(new Error('no se puede cambiar'));
        const link = await svc.publishToMeli('p1', 'u', 'c1');
        expect(link.syncStatus).toBe('published');
        expect(link.lastError).toMatch(/Enlazada con la publicación existente MPE111/);
    });
});
