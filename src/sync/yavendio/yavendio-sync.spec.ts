import { YavendioSyncService } from './yavendio-sync.service';

function construir(opts: { familia: any[]; enlaces?: any[]; remoto?: any } ) {
    const enlaces: any[] = [...(opts.enlaces ?? [])];
    let siguienteVariante = 500;
    const api: any = {
        listCatalogs: jest.fn(async () => [{ id: 7 }]),
        createProduct: jest.fn(async () => ({ id: 9876 })),
        getProduct: jest.fn(async () => opts.remoto ?? { id: 9876, options: [], variants: [] }),
        createOption: jest.fn(async (_k: string, _p: any, name: string, values: string[]) => ({ id: name === 'Talla' ? 10 : 11, name, values: values.map((v, i) => ({ id: (name === 'Talla' ? 100 : 200) + i, name: v })) })),
        addOptionValue: jest.fn(async (_k: string, _p: any, _o: number, name: string) => ({ id: 300, name })),
        createVariant: jest.fn(async () => ({ id: siguienteVariante++ })),
        addVariantMedia: jest.fn(async () => undefined),
        updateVariant: jest.fn(async () => undefined),
    };
    const svc: any = new YavendioSyncService(
        {
            findOne: jest.fn(async ({ where }: any) => opts.familia.find((p) => p.id === where.id) ?? null),
            find: jest.fn(async () => opts.familia),
        } as any,
        {
            findOne: jest.fn(async ({ where }: any) => enlaces.find((e) => e.product.id === where.product.id) ?? null),
            create: jest.fn((x: any) => x),
            save: jest.fn(async (l: any) => { if (!enlaces.includes(l)) enlaces.push(l); return l; }),
        } as any,
        api,
        { getValidConnectionById: jest.fn(async () => ({ id: 'c1', accessToken: 'yv_live_v1_x', secrets: { currency: 'PEN' } })) } as any,
        { notify: jest.fn(async () => undefined) } as any,
    );
    return { svc: svc as YavendioSyncService, api, enlaces };
}

const grupo = { id: 'g1', name: 'Polo Negro', parentSku: 'POL', axes: [{ name: 'Talla', values: ['S', 'M'] }] };
const variante = (id: string, sku: string, talla: string, extra: any = {}) => ({ id, sku, name: 'Polo', price: 49.9, stock: 4, images: [{ url: `https://cdn/${id}.jpg` }], group: grupo, variantValues: { Talla: talla }, ...extra });

describe('Yavendió: publicar y mantener al día', () => {
    it('publica un grupo como un solo producto con sus opciones y variantes, y guarda el vínculo por variante (sin SKU en Yavendió)', async () => {
        const { svc, api, enlaces } = construir({ familia: [variante('a', 'POL-S', 'S'), variante('b', 'POL-M', 'M')] });
        const r = await svc.publish('a', 'u', 'c1');

        expect(r).toEqual({ externalId: '9876', creadas: 2 });
        expect(api.createProduct).toHaveBeenCalledTimes(1);
        expect(api.createOption).toHaveBeenCalledWith('yv_live_v1_x', '9876', 'Talla', ['S', 'M']);
        const cuerpo = api.createVariant.mock.calls[1][2];
        expect(cuerpo).toMatchObject({ name: 'Polo Negro - M', base_price: 49.9, currency: 'PEN', status: 'available', option_values: [101] });
        expect(cuerpo).not.toHaveProperty('sku');
        expect(api.addVariantMedia).toHaveBeenCalledTimes(2);

        const finales = enlaces.filter((e) => e.syncStatus === 'published');
        expect(finales.map((e) => [e.product.id, e.externalId, e.variationId])).toEqual([['a', '9876', '500'], ['b', '9876', '501']]);
    });

    it('repetir la publicación no crea otro producto ni repite las variantes ya creadas', async () => {
        const { svc, api } = construir({
            familia: [variante('a', 'POL-S', 'S'), variante('b', 'POL-M', 'M')],
            enlaces: [
                { product: { id: 'a' }, externalId: '9876', variationId: '500', syncStatus: 'published', marketplace: 'yavendio' },
                { product: { id: 'b' }, externalId: '9876', variationId: null, syncStatus: 'error', marketplace: 'yavendio' },
            ],
            remoto: { id: 9876, options: [{ id: 10, name: 'Talla', values: [{ id: 100, name: 'S' }, { id: 101, name: 'M' }] }], variants: [{ id: 500, name: 'x' }] },
        });
        const r = await svc.publish('b', 'u', 'c1');

        expect(api.createProduct).not.toHaveBeenCalled();
        expect(api.createOption).not.toHaveBeenCalled();
        expect(api.createVariant).toHaveBeenCalledTimes(1);
        expect(r.creadas).toBe(1);
    });

    it('si una variante nueva usa un valor que la opción no tiene, lo agrega a la opción existente', async () => {
        const { svc, api } = construir({
            familia: [variante('a', 'POL-S', 'S'), variante('b', 'POL-M', 'M')],
            enlaces: [{ product: { id: 'a' }, externalId: '9876', variationId: '500', syncStatus: 'published', marketplace: 'yavendio' }],
            remoto: { id: 9876, options: [{ id: 10, name: 'Talla', values: [{ id: 100, name: 'S' }] }], variants: [{ id: 500, name: 'x' }] },
        });
        await svc.publish('b', 'u', 'c1');
        expect(api.addOptionValue).toHaveBeenCalledWith('yv_live_v1_x', '9876', 10, 'M');
        expect(api.createVariant.mock.calls[0][2].option_values).toEqual([300]);
    });

    it('un producto simple se publica con «Presentación: Estándar»', async () => {
        const simple = { id: 's', sku: 'KI-1', name: 'Taza', price: 10, stock: 0, images: [], group: null, variantValues: null };
        const { svc, api } = construir({ familia: [simple] });
        await svc.publish('s', 'u', 'c1');
        expect(api.createOption).toHaveBeenCalledWith('yv_live_v1_x', '9876', 'Presentación', ['Estándar']);
        expect(api.createVariant.mock.calls[0][2].status).toBe('not_available'); // sin stock
    });

    it('un producto sin precio se rechaza antes de crear nada en Yavendió', async () => {
        const { svc, api } = construir({ familia: [variante('a', 'POL-S', 'S', { price: null })] });
        await expect(svc.publish('a', 'u', 'c1')).rejects.toThrow(/precio/);
        expect(api.createProduct).not.toHaveBeenCalled();
    });

    it('actualiza precio y disponibilidad de la variante vinculada', async () => {
        const { svc, api } = construir({
            familia: [variante('a', 'POL-S', 'S', { price: 59.9, stock: 0 })],
            enlaces: [{ product: { id: 'a' }, externalId: '9876', variationId: '500', syncStatus: 'published', marketplace: 'yavendio', pausedByUser: false }],
        });
        await svc.pushInventory('a', 'c1');
        expect(api.updateVariant).toHaveBeenCalledWith('yv_live_v1_x', '9876', '500', { base_price: 59.9, status: 'not_available' });
    });

    it('si la variante ya no existe en Yavendió (404) el enlace queda en error para vincularla de nuevo', async () => {
        const { svc, api, enlaces } = construir({
            familia: [variante('a', 'POL-S', 'S')],
            enlaces: [{ product: { id: 'a' }, externalId: '9876', variationId: '500', syncStatus: 'published', marketplace: 'yavendio' }],
        });
        api.updateVariant.mockRejectedValueOnce(Object.assign(new Error('no existe'), { yavendioStatus: 404 }));
        await svc.pushInventory('a', 'c1');
        expect(enlaces[0].syncStatus).toBe('error');
        expect(enlaces[0].lastError).toMatch(/vincularla de nuevo/);
    });
});
