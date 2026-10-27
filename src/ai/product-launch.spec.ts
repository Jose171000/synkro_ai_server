import { ProductLaunchService } from './product-launch.service';

function construir(opts: { cuentas?: any[]; enqueueError?: string; producto?: any } = {}) {
    const producto = opts.producto ?? {
        id: 'p1', price: 99, name: 'Torre', aiTitle: 'Torre Montessori', description: 'texto', aiDescription: 'desc',
        marketplaceIds: { mercadolibre_category_id: 'MPE1' }, aiAttributes: { brand: 'GENERICO', mercadolibre_attributes: { COLOR: 'Azul' } },
    };
    const sync: any = {
        getConnections: jest.fn(async () => opts.cuentas ?? [
            { id: 'fa1', marketplace: 'falabella', status: 'active' },
            { id: 'ml1', marketplace: 'mercadolibre', status: 'active' },
            { id: 'ml2', marketplace: 'mercadolibre', status: 'active' },
            { id: 'fa-baja', marketplace: 'falabella', status: 'revoked' },
        ]),
        enqueuePublish: jest.fn(async () => {
            if (opts.enqueueError) throw new Error(opts.enqueueError);
            return { message: 'ok' };
        }),
        findScopedProduct: jest.fn(async () => producto),
        getValidConnectionById: jest.fn(async () => ({ accessToken: 'tok-ml' })),
        resolveMeliCategory: jest.fn(async () => 'MPE124007'),
        predictMeliCategoryFromQueries: jest.fn(async () => 'MPE444279'),
        saveProduct: jest.fn(async (p: any) => p),
    };
    const falabellaPrep: any = { preparar: jest.fn(async () => ({ listo: true, category: { id: '956', path: 'x', auto: true } })) };
    const ai: any = { consultasDeCategoria: jest.fn(async () => ['utensilio para desmenuzar carne']), completarAtributos: jest.fn(async () => ({ values: { MATERIAL: 'Madera' }, estimated: ['MATERIAL'] })) };
    const canales: any = {
        requisitos: jest.fn(async () => [
            { name: 'COLOR', description: 'Color', example: '', isRequired: true },
            { name: 'MATERIAL', description: 'Material', example: '', isRequired: true },
        ]),
    };
    return { service: new ProductLaunchService(sync, falabellaPrep, ai, canales), sync, falabellaPrep, ai, producto };
}

const SCOPE = { userId: 'u1', storeId: 't1' };

describe('lanzar un producto en un paso', () => {
    it('prepara Falabella, completa lo que falta en Mercado Libre y publica en cada cuenta activa', async () => {
        const { service, sync, falabellaPrep, ai, producto } = construir();
        const r = await service.lanzar(SCOPE, 'p1', ['falabella', 'mercadolibre']);

        expect(falabellaPrep.preparar).toHaveBeenCalledWith(SCOPE, 'p1', 'fa1');
        // solo se estima lo que faltaba (MATERIAL), no lo que ya tenía (COLOR)
        expect(ai.completarAtributos.mock.calls[0][2].map((a: any) => a.name)).toEqual(['MATERIAL']);
        expect(producto.aiAttributes.mercadolibre_attributes).toEqual({ COLOR: 'Azul', MATERIAL: 'Madera' });
        expect(producto.aiAttributes.estimated.attributes.mercadolibre).toEqual(['MATERIAL']);
        expect(r.estimatedMeli).toEqual(['MATERIAL']);

        // una orden por cuenta activa: 1 de Falabella y 2 de Mercado Libre; la dada de baja no cuenta
        expect(sync.enqueuePublish).toHaveBeenCalledTimes(3);
        expect(r.channels).toEqual([
            { marketplace: 'falabella', accounts: 1, status: 'encolado', message: 'Publicando en Falabella.' },
            { marketplace: 'mercadolibre', accounts: 2, status: 'encolado', message: 'Publicando en Mercado Libre.' },
        ]);
        expect(r.falabella?.listo).toBe(true);
    });

    it('en Mercado Libre completa también los atributos opcionales y le da a la IA las fotos y el texto del cliente', async () => {
        const { service, canales, ai, producto } = (() => {
            const c = construir();
            c.service['canales'].requisitos = jest.fn(async () => [
                { name: 'COLOR', description: 'Color', example: '', isRequired: true },
                { name: 'MATERIAL', description: 'Material', example: '', isRequired: false },
            ]);
            c.producto.aiAttributes.vision = { productType: 'torre', material: 'madera' };
            return { ...c, canales: c.service['canales'] };
        })();
        await service.lanzar(SCOPE, 'p1', ['mercadolibre']);

        expect(canales.requisitos).toHaveBeenCalledWith('mercadolibre', 'MPE1', undefined, undefined, undefined, { todos: true });
        // MATERIAL es opcional y aun así se pide; COLOR ya estaba
        expect(ai.completarAtributos.mock.calls[0][2].map((a: any) => a.name)).toEqual(['MATERIAL']);
        expect(ai.completarAtributos.mock.calls[0][4]).toEqual(expect.objectContaining({ textoCliente: 'texto', vision: { productType: 'torre', material: 'madera' } }));
        expect(producto.aiAttributes.mercadolibre_attributes.MATERIAL).toBe('Madera');
    });

    it('sin categoría de Mercado Libre guardada la predice con el token de la cuenta, la guarda y completa sus atributos', async () => {
        const { service, sync, ai, producto } = construir({
            producto: { id: 'p1', sku: 'OG310', price: 39.9, name: 'Zapatera', description: 'texto', aiAttributes: { brand: 'GENERICO' }, marketplaceIds: {} },
        });
        await service.lanzar(SCOPE, 'p1', ['mercadolibre']);

        expect(sync.resolveMeliCategory).toHaveBeenCalledWith(producto, 'tok-ml');
        expect(producto.aiAttributes.mercadolibre_category_id).toBe('MPE124007');
        expect(ai.completarAtributos).toHaveBeenCalled();
        expect(producto.aiAttributes.mercadolibre_attributes).toEqual(expect.objectContaining({ MATERIAL: 'Madera' }));
    });

    it('un campo numérico guardado con texto se borra y se vuelve a completar', async () => {
        const c = construir();
        c.producto.aiAttributes.mercadolibre_attributes = { COLOR: 'Azul', DISHES_CAPACITY: '3 niveles' };
        c.service['canales'].requisitos = jest.fn(async () => [
            { name: 'COLOR', description: 'Color', example: '', isRequired: true },
            { name: 'DISHES_CAPACITY', description: 'Capacidad', example: '', isRequired: true, valueType: 'number' },
        ]);
        c.ai.completarAtributos.mockResolvedValueOnce({ values: { DISHES_CAPACITY: '20' }, estimated: [] });
        await c.service.lanzar(SCOPE, 'p1', ['mercadolibre']);

        expect(c.ai.completarAtributos.mock.calls[0][2].map((a: any) => a.name)).toEqual(['DISHES_CAPACITY']);
        expect(c.producto.aiAttributes.mercadolibre_attributes.DISHES_CAPACITY).toBe('20');
    });

    it('si vende por Unidad y la categoría pide la cantidad de envases, pone 1', async () => {
        const c = construir();
        c.producto.aiAttributes.mercadolibre_attributes = { COLOR: 'Azul', SALE_FORMAT: 'Unidad' };
        c.service['canales'].requisitos = jest.fn(async () => [
            { name: 'COLOR', description: 'Color', example: '', isRequired: true },
            { name: 'SALE_FORMAT', description: 'Formato', example: '', isRequired: false },
            { name: 'UNITS_PER_PACK', description: 'Cantidad de envases', example: '', isRequired: false },
        ]);
        c.ai.completarAtributos.mockResolvedValueOnce({ values: {}, estimated: [] });
        await c.service.lanzar(SCOPE, 'p1', ['mercadolibre']);
        expect(c.producto.aiAttributes.mercadolibre_attributes.UNITS_PER_PACK).toBe('1');
    });

    it('si el título no encuentra categoría en Mercado Libre prueba con las frases que propone la IA', async () => {
        const c = construir({
            producto: { id: 'p1', sku: 'CO252', price: 20, name: 'DESMENUZADOR DE POLLO', description: 'texto', aiAttributes: {}, marketplaceIds: {} },
        });
        c.sync.resolveMeliCategory = jest.fn(async () => { throw new Error('No se pudo determinar la categoría'); });
        await c.service.lanzar(SCOPE, 'p1', ['mercadolibre']);

        expect(c.ai.consultasDeCategoria).toHaveBeenCalled();
        expect(c.sync.predictMeliCategoryFromQueries).toHaveBeenCalledWith(['utensilio para desmenuzar carne'], 'tok-ml');
        expect(c.producto.aiAttributes.mercadolibre_category_id).toBe('MPE444279');
    });

    it('ignora canales no soportados y avisa si la tienda no tiene cuenta del canal', async () => {
        const { service, falabellaPrep } = construir({ cuentas: [{ id: 'ml1', marketplace: 'mercadolibre', status: 'active' }] });
        const r = await service.lanzar(SCOPE, 'p1', ['falabella', 'woocommerce', 'amazon']);
        expect(r.channels).toEqual([expect.objectContaining({ marketplace: 'falabella', status: 'omitido', accounts: 0 })]);
        expect(falabellaPrep.preparar).not.toHaveBeenCalled();
    });

    it('si ya estaba publicado lo marca como omitido y no como error; otro fallo sí es error', async () => {
        const yaPublicado = construir({ enqueueError: 'Este producto ya está publicado en Falabella.' });
        expect((await yaPublicado.service.lanzar(SCOPE, 'p1', ['falabella'])).channels[0].status).toBe('omitido');

        const fallo = construir({ enqueueError: 'Esta tienda no tiene una cuenta conectada' });
        const r = await fallo.service.lanzar(SCOPE, 'p1', ['falabella']);
        expect(r.channels[0]).toMatchObject({ status: 'error', message: expect.stringContaining('cuenta conectada') });
    });

    it('si Falabella todavía no tiene lo que pide, no dice que está publicando y explica qué falta', async () => {
        const { service, falabellaPrep, sync } = construir();
        falabellaPrep.preparar.mockResolvedValue({ listo: false, motivo: 'le faltan datos que pide su categoria en Falabella: Material' });
        const r = await service.lanzar(SCOPE, 'p1', ['falabella']);
        expect(sync.enqueuePublish).not.toHaveBeenCalled();
        expect(r.channels[0]).toMatchObject({ status: 'error', message: expect.stringContaining('Material') });
    });

    it('si la preparación falla igual intenta publicar: el motivo queda en la ficha', async () => {
        const { service, falabellaPrep, sync } = construir();
        falabellaPrep.preparar.mockRejectedValue(new Error('IA caída'));
        const r = await service.lanzar(SCOPE, 'p1', ['falabella']);
        expect(sync.enqueuePublish).toHaveBeenCalledTimes(1);
        expect(r.channels[0].status).toBe('encolado');
        expect(r.falabella).toBeUndefined();
    });
});

describe('lanzar un producto sin precio', () => {
    it('no encola ni gasta IA: dice que el canal exige precio', async () => {
        const { service, sync, ai } = construir({ producto: { id: 'p1', price: 0, name: 'Disco', marketplaceIds: {}, aiAttributes: {} } });
        const r = await service.lanzar(SCOPE, 'p1', ['mercadolibre']);
        expect(r.channels[0]).toMatchObject({ marketplace: 'mercadolibre', status: 'error', message: expect.stringContaining('exige precio') });
        expect(sync.enqueuePublish).not.toHaveBeenCalled();
        expect(ai.completarAtributos).not.toHaveBeenCalled();
    });
});
