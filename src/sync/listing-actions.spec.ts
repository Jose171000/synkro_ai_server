import { BadRequestException } from '@nestjs/common';
import { ListingActionsService } from './listing-actions.service';

/**
 * Pausar, reanudar y quitar un producto de sus canales. Se simulan los canales: aquí no se toca ninguno real.
 * Lo que se protege: Mercado Libre cambia el estado de la publicación; Falabella se pausa con stock 0 y se quita con
 * ProductRemove; una pausa no se deshace con un envío normal de stock; un canal que falla no tumba a los demás.
 */
function enlace(over: any = {}) {
    return {
        id: over.id ?? 'l1',
        marketplace: 'mercadolibre',
        externalId: 'MPE1',
        syncStatus: 'published',
        pausedByUser: false,
        variationId: null,
        lastStockSynced: 10,
        product: { id: 'p1', sku: 'SKU-1' },
        connection: { id: 'c-' + (over.id ?? 'l1'), label: 'Cuenta', owner: { id: 'u1' } },
        ...over,
    };
}

function construir(enlaces: any[]) {
    const repo: any = {
        find: jest.fn(async ({ where }: any) => enlaces.filter(e =>
            (!where.id || where.id._value?.includes(e.id)) &&
            (!where.externalId || e.externalId === where.externalId))),
        findOne: jest.fn(async ({ where }: any) => enlaces.find(e => e.id === where.id) ?? null),
        save: jest.fn(async (e: any) => e),
    };
    const sync: any = {
        findScopedProduct: jest.fn(async () => ({ id: 'p1' })),
        getValidConnectionById: jest.fn(async () => ({ accessToken: 'tok' })),
        getFalabellaCredentials: jest.fn(async () => ({})),
        registrarFeedFalabella: jest.fn(async () => 'feed'),
        pushInventoryToMeli: jest.fn(async () => undefined),
        pushInventoryToFalabella: jest.fn(async () => ({ status: 'enviado', feeds: [] })),
        falabellaOperatorCode: 'fape',
    };
    const meli: any = { setItemStatus: jest.fn(async () => undefined) };
    const fala: any = { updateStock: jest.fn(async () => 'f1'), productRemove: jest.fn(async () => 'f2') };
    return { servicio: new ListingActionsService(repo, sync, meli, fala), repo, sync, meli, fala };
}

const ambito = { userId: 'u1', storeId: 's1' };

describe('ListingActionsService', () => {
    it('pausa en Mercado Libre cambiando el estado de la publicación', async () => {
        const l = enlace();
        const { servicio, meli } = construir([l]);
        const r = await servicio.ejecutar(ambito, 'p1', 'pause');
        expect(meli.setItemStatus).toHaveBeenCalledWith('tok', 'MPE1', 'paused');
        expect(l.syncStatus).toBe('paused');
        expect(l.pausedByUser).toBe(true);
        expect(r.results[0].ok).toBe(true);
    });

    it('pausa en Falabella dejando el stock en 0 y anota el feed', async () => {
        const l = enlace({ marketplace: 'falabella', externalId: 'SHOP1' });
        const { servicio, fala, sync } = construir([l]);
        await servicio.ejecutar(ambito, 'p1', 'pause');
        expect(fala.updateStock).toHaveBeenCalledWith({}, [{ sellerSku: 'SKU-1', quantity: 0 }], { operatorCode: 'fape' });
        expect(sync.registrarFeedFalabella).toHaveBeenCalledWith('u1', l.connection.id, 'UpdateStock', 'SKU-1', 'f1');
        expect(l.pausedByUser).toBe(true);
        expect(l.lastStockSynced).toBe(0);
    });

    it('reanudar en Falabella fuerza el envío del stock real', async () => {
        const l = enlace({ marketplace: 'falabella', syncStatus: 'paused', pausedByUser: true, lastStockSynced: 0 });
        const { servicio, sync } = construir([l]);
        await servicio.ejecutar(ambito, 'p1', 'resume');
        expect(l.pausedByUser).toBe(false);
        expect(l.syncStatus).toBe('published');
        expect(l.lastStockSynced).toBeNull();
        expect(sync.pushInventoryToFalabella).toHaveBeenCalledWith('p1', l.connection.id);
    });

    it('reanudar en Mercado Libre reactiva y pone al día el stock', async () => {
        const l = enlace({ syncStatus: 'paused', pausedByUser: true });
        const { servicio, meli, sync } = construir([l]);
        await servicio.ejecutar(ambito, 'p1', 'resume');
        expect(meli.setItemStatus).toHaveBeenCalledWith('tok', 'MPE1', 'active');
        expect(sync.pushInventoryToMeli).toHaveBeenCalledWith('p1', l.connection.id);
        expect(l.syncStatus).toBe('published');
    });

    it('una ficha de Falabella pausada que el canal muestra «publicada» sigue contando como pausada (se puede reanudar)', async () => {
        const l = enlace({ marketplace: 'falabella', syncStatus: 'published', pausedByUser: true });
        const { servicio } = construir([l]);
        await expect(servicio.ejecutar(ambito, 'p1', 'pause')).rejects.toBeInstanceOf(BadRequestException);
        const r = await servicio.ejecutar(ambito, 'p1', 'resume');
        expect(r.results[0].ok).toBe(true);
    });

    it('quita en Falabella con ProductRemove y deja el enlace como retirado', async () => {
        const l = enlace({ marketplace: 'falabella' });
        const { servicio, fala, sync } = construir([l]);
        await servicio.ejecutar(ambito, 'p1', 'remove');
        expect(fala.productRemove).toHaveBeenCalledWith({}, ['SKU-1']);
        expect(sync.registrarFeedFalabella).toHaveBeenCalledWith('u1', l.connection.id, 'ProductRemove', 'SKU-1', 'f2');
        expect(l.syncStatus).toBe('removed');
    });

    it('quita en Mercado Libre cerrando la publicación', async () => {
        const l = enlace();
        const { servicio, meli } = construir([l]);
        await servicio.ejecutar(ambito, 'p1', 'remove');
        expect(meli.setItemStatus).toHaveBeenCalledWith('tok', 'MPE1', 'closed');
        expect(l.syncStatus).toBe('removed');
    });

    it('en Mercado Libre con variantes la pausa afecta a todos los enlaces de la publicación', async () => {
        const a = enlace({ id: 'a', variationId: 'V1' });
        const b = enlace({ id: 'b', variationId: 'V2' });
        const { servicio, meli } = construir([a, b]);
        await servicio.ejecutar(ambito, 'p1', 'pause', ['a']);
        expect(meli.setItemStatus).toHaveBeenCalledTimes(1);
        expect(a.pausedByUser && b.pausedByUser).toBe(true);
    });

    it('el botón general actúa sobre todos los canales; si uno falla, los demás siguen y se informa', async () => {
        const ml = enlace({ id: 'ml' });
        const fa = enlace({ id: 'fa', marketplace: 'falabella' });
        const { servicio, meli, fala } = construir([ml, fa]);
        meli.setItemStatus.mockRejectedValueOnce(new Error('Mercado Libre caído'));
        const r = await servicio.ejecutar(ambito, 'p1', 'pause');
        expect(fala.updateStock).toHaveBeenCalled();
        expect(r.results.find(x => x.marketplace === 'mercadolibre')!.ok).toBe(false);
        expect(r.results.find(x => x.marketplace === 'falabella')!.ok).toBe(true);
        expect(ml.syncStatus).toBe('published'); // el que falló no cambia de estado
        expect(r.message).toMatch(/1 de 2/);
    });

    it('los canales que aún no se controlan desde Synkro se avisan sin tocarlos', async () => {
        const l = enlace({ marketplace: 'woocommerce' });
        const { servicio, meli, fala } = construir([l]);
        const r = await servicio.ejecutar(ambito, 'p1', 'pause');
        expect(r.results[0].ok).toBe(false);
        expect(meli.setItemStatus).not.toHaveBeenCalled();
        expect(fala.updateStock).not.toHaveBeenCalled();
        expect(l.syncStatus).toBe('published');
    });

    it('una ya retirada no admite acciones, y una en proceso de publicarse solo admite quitarse (no pausar ni reanudar)', async () => {
        const { servicio } = construir([enlace({ syncStatus: 'removed' }), enlace({ id: 'x', syncStatus: 'pending' })]);
        await expect(servicio.ejecutar(ambito, 'p1', 'pause')).rejects.toBeInstanceOf(BadRequestException);
        await expect(servicio.ejecutar(ambito, 'p1', 'resume')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('una ya retirada sola no tiene nada que quitar', async () => {
        const { servicio } = construir([enlace({ syncStatus: 'removed' })]);
        await expect(servicio.ejecutar(ambito, 'p1', 'remove')).rejects.toBeInstanceOf(BadRequestException);
    });
});

describe('verificar en los canales lo que se quitó', () => {
    const producto = (sku: string) => ({ id: `id-${sku}`, sku });
    const conexion = (id: string, marketplace: string) => ({ id, marketplace, label: `cuenta-${marketplace}` });
    const enlace = (sku: string, marketplace: string, externalId: string, syncStatus: string) => ({ product: producto(sku), marketplace, externalId, syncStatus, connection: conexion(`c-${marketplace}`, marketplace) });

    function armar(enlaces: any[], ml: { items: any[]; notFound?: string[] }, fala: any[]) {
        const repo: any = { find: jest.fn(async () => enlaces) };
        const sync: any = { getValidConnectionById: jest.fn(async (id: string) => ({ ...conexion(id, id.replace('c-', '')), accessToken: 't' })), credentialsOf: jest.fn(() => ({ userId: 'u', apiKey: 'k' })) };
        const meli: any = { getItems: jest.fn(async () => ({ items: ml.items, notFound: ml.notFound ?? [] })) };
        const falabella: any = { getProductsBySku: jest.fn(async () => fala) };
        return { servicio: new ListingActionsService(repo, sync, meli, falabella), meli, falabella };
    }

    it('lee el estado real de cada publicación en Mercado Libre y si la ficha sigue en Falabella', async () => {
        const { servicio, meli, falabella } = armar(
            [enlace('BL1', 'mercadolibre', 'MPE1', 'removed'), enlace('BL1', 'falabella', 'BL1', 'removed'), enlace('BL2', 'mercadolibre', 'MPE2', 'removed')],
            { items: [{ id: 'MPE1', status: 'closed', sub_status: ['expired'] }, { id: 'MPE2', status: 'active' }] },
            [{ SellerSku: 'BL1', Status: 'deleted', QCStatus: 'approved' }],
        );
        const r = await servicio.verificarEnCanales({ userId: 'u', storeId: 's' }, ['BL1', 'BL2']);
        expect(meli.getItems).toHaveBeenCalledWith('t', ['MPE1', 'MPE2']);
        expect(falabella.getProductsBySku).toHaveBeenCalledWith({ userId: 'u', apiKey: 'k' }, ['BL1']);
        expect(r.find((x) => x.sku === 'BL1')).toMatchObject({
            mercadolibre: [{ id: 'MPE1', estado: 'closed', subestado: 'expired' }],
            falabella: [{ existe: true, estado: 'deleted' }],
        });
        // lo que sigue activo en el canal se ve: no se da por quitado solo porque Synkro lo marcó
        expect(r.find((x) => x.sku === 'BL2')!.mercadolibre[0].estado).toBe('active');
    });

    it('una publicación que ya no existe en el canal se dice, y una ficha ausente de Falabella también', async () => {
        const { servicio } = armar([enlace('BL3', 'mercadolibre', 'MPE9', 'removed'), enlace('BL3', 'falabella', 'BL3', 'removed')], { items: [], notFound: ['MPE9'] }, []);
        const r = await servicio.verificarEnCanales({ userId: 'u', storeId: 's' }, ['BL3']);
        expect(r[0].mercadolibre[0].estado).toBe('no existe');
        expect(r[0].falabella[0]).toMatchObject({ existe: false, estado: null });
    });
});

describe('quitar una publicación que el canal todavía está revisando', () => {
    function armar(enlace: any) {
        const repo: any = { find: jest.fn(async () => [enlace]), findOne: jest.fn(async () => ({ ...enlace, connection: { ...enlace.connection, owner: { id: 'o1' } } })), save: jest.fn(async (e: any) => e) };
        const sync: any = {
            findScopedProduct: jest.fn(async () => ({ id: 'p1' })),
            getValidConnectionById: jest.fn(async () => ({ accessToken: 't' })),
            getFalabellaCredentials: jest.fn(async () => ({ userId: 'u', apiKey: 'k' })),
            registrarFeedFalabella: jest.fn(async () => undefined),
            falabellaOperatorCode: 'OP',
        };
        const meli: any = { setItemStatus: jest.fn(async () => undefined) };
        const falabella: any = { productRemove: jest.fn(async () => 'feed-1') };
        return { servicio: new ListingActionsService(repo, sync, meli, falabella), meli, falabella, sync };
    }
    const base = (marketplace: string, externalId: string) => ({ id: 'l1', marketplace, externalId, syncStatus: 'pending', pausedByUser: false, product: { id: 'p1', sku: 'BL1' }, connection: { id: 'c1', label: 'cuenta' } });

    it('una ficha de Falabella pendiente se da de baja, para que no salga a la venta si la aprueban después', async () => {
        const e: any = base('falabella', 'BL1');
        const { servicio, falabella } = armar(e);
        const r = await servicio.ejecutar({ userId: 'u', storeId: 's' }, 'p1', 'remove');
        expect(falabella.productRemove).toHaveBeenCalledWith({ userId: 'u', apiKey: 'k' }, ['BL1']);
        expect(r.results[0].ok).toBe(true);
        expect(e.syncStatus).toBe('removed');
    });

    it('una publicación de Mercado Libre en revisión se cierra', async () => {
        const e: any = base('mercadolibre', 'MPE9');
        const { servicio, meli } = armar(e);
        await servicio.ejecutar({ userId: 'u', storeId: 's' }, 'p1', 'remove');
        expect(meli.setItemStatus).toHaveBeenCalledWith('t', 'MPE9', 'closed');
        expect(e.syncStatus).toBe('removed');
    });

    it('un envío pendiente que nunca creó nada en Mercado Libre solo queda anotado, sin llamar al canal', async () => {
        const e: any = base('mercadolibre', '');
        const { servicio, meli } = armar(e);
        await servicio.ejecutar({ userId: 'u', storeId: 's' }, 'p1', 'remove');
        expect(meli.setItemStatus).not.toHaveBeenCalled();
        expect(e.syncStatus).toBe('removed');
    });
});

describe('ListingActionsService · Ripley', () => {
    const delRipley = (over: any = {}) => enlace({ marketplace: 'ripley', externalId: '10407700', product: { id: 'p1', sku: 'BP000007', stock: 4 }, ...over });
    const armar = (enlaces: any[], fallo?: string) => {
        const base = construir(enlaces);
        const ecommerce: any = { accionSobreOfertaDeRipley: jest.fn(async () => { if (fallo) throw new BadRequestException(fallo); }) };
        const servicio = new ListingActionsService((base as any).repo, (base as any).sync, (base as any).meli, (base as any).fala, ecommerce);
        return { servicio, ecommerce };
    };

    it('pausar deja la oferta con stock 0 y queda pausada por la persona', async () => {
        const l = delRipley();
        const { servicio, ecommerce } = armar([l]);
        const r = await servicio.ejecutar(ambito, 'p1', 'pause');
        expect(ecommerce.accionSobreOfertaDeRipley).toHaveBeenCalledWith(l, 'pause');
        expect(l.syncStatus).toBe('paused');
        expect(l.pausedByUser).toBe(true);
        expect(l.lastStockSynced).toBe(0);
        expect(r.results[0].ok).toBe(true);
    });

    it('reanudar restaura el stock real y quita la marca de pausa', async () => {
        const l = delRipley({ syncStatus: 'paused', pausedByUser: true, lastStockSynced: 0 });
        const { servicio, ecommerce } = armar([l]);
        await servicio.ejecutar(ambito, 'p1', 'resume');
        expect(ecommerce.accionSobreOfertaDeRipley).toHaveBeenCalledWith(l, 'resume');
        expect(l.syncStatus).toBe('published');
        expect(l.pausedByUser).toBe(false);
        expect(l.lastStockSynced).toBe(4);
    });

    it('quitar borra la oferta y la publicación queda como quitada', async () => {
        const l = delRipley();
        const { servicio, ecommerce } = armar([l]);
        await servicio.ejecutar(ambito, 'p1', 'remove');
        expect(ecommerce.accionSobreOfertaDeRipley).toHaveBeenCalledWith(l, 'remove');
        expect(l.syncStatus).toBe('removed');
    });

    it('si Ripley o el SKU no lo permiten, no se cambia nada en Synkro y se dice por qué', async () => {
        const l = delRipley();
        const { servicio } = armar([l], 'El SKU BP000007 todavía no está habilitado para controlarlo desde Synkro en Ripley (piloto).');
        const r = await servicio.ejecutar(ambito, 'p1', 'pause');
        expect(r.results[0].ok).toBe(false);
        expect(r.results[0].message).toContain('no está habilitado');
        expect(l.syncStatus).toBe('published');
        expect(l.pausedByUser).toBe(false);
    });
});

describe('ListingActionsService · todas las variantes', () => {
    const variante = (id: string, over: any = {}) => enlace({ id, marketplace: 'ripley', externalId: 'O-' + id, product: { id: 'v-' + id, sku: 'SKU-' + id, stock: 3 }, ...over });
    const armar = (enlaces: any[]) => {
        const base: any = construir(enlaces);
        base.sync.familiaDe = jest.fn(async () => [{ id: 'v-a' }, { id: 'v-b' }, { id: 'v-c' }]);
        base.repo.find = jest.fn(async () => enlaces);
        const ecommerce: any = { accionSobreOfertaDeRipley: jest.fn(async () => undefined) };
        return { servicio: new ListingActionsService(base.repo, base.sync, base.meli, base.fala, ecommerce), ecommerce, repo: base.repo, sync: base.sync };
    };

    it('pausa de una vez todas las variantes del producto en el canal', async () => {
        const ls = [variante('a'), variante('b'), variante('c')];
        const { servicio, ecommerce, repo } = armar(ls);
        const r = await servicio.ejecutarGrupo(ambito, 'v-a', 'pause', 'c-a');
        expect(ecommerce.accionSobreOfertaDeRipley).toHaveBeenCalledTimes(3);
        expect(ls.every((l) => l.syncStatus === 'paused' && l.pausedByUser)).toBe(true);
        expect(r.results).toHaveLength(3);
        // busca entre las variantes del grupo y solo en esa cuenta
        const donde = repo.find.mock.calls[0][0].where;
        expect(donde.connection.id).toBe('c-a');
    });

    it('solo toca las variantes que admiten la acción y avisa de las que fallan sin tumbar a las demás', async () => {
        const ls = [variante('a'), variante('b', { syncStatus: 'paused', pausedByUser: true }), variante('c')];
        const { servicio, ecommerce } = armar(ls);
        ecommerce.accionSobreOfertaDeRipley.mockImplementationOnce(async () => { throw new BadRequestException('Ripley no respondió'); });
        const r = await servicio.ejecutarGrupo(ambito, 'v-a', 'pause');
        expect(r.results).toHaveLength(2); // la ya pausada se omite
        expect(r.results.filter((x) => x.ok)).toHaveLength(1);
        expect(r.message).toContain('Ripley no respondió');
    });
});
