import { ProductLaunchService } from './product-launch.service';

function construir(opts: { cuentas?: any[]; enqueueError?: string; producto?: any; familia?: any[]; ruta?: string } = {}) {
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
        familiaDe: jest.fn(async () => opts.familia ?? [producto]),
        nombreParaFalabella: jest.fn((n: string) => String(n).slice(0, 100)),
        getValidConnectionById: jest.fn(async () => ({ accessToken: 'tok-ml' })),
        resolveMeliCategory: jest.fn(async () => 'MPE124007'),
        meliCategoryPath: jest.fn(async (id: string) => opts.ruta ?? 'Ruta › ' + id),
        suggestMeliCategories: jest.fn(async () => [{ id: 'MPE1', path: 'A › B' }, { id: 'MPE2', path: 'C › D' }]),
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

    it('si el título no halla categoría no decide con frases de la IA: no publica y devuelve las recomendadas para elegir', async () => {
        const c = construir({
            producto: { id: 'p1', sku: 'CO252', price: 20, name: 'DESMENUZADOR', description: 'texto', aiAttributes: {}, marketplaceIds: {} },
        });
        c.sync.resolveMeliCategory = jest.fn(async () => { throw new Error('nada'); });
        const r = await c.service.lanzar(SCOPE, 'p1', ['mercadolibre']);

        expect(r.meliCategory).toEqual({ options: [{ id: 'MPE1', path: 'A › B' }, { id: 'MPE2', path: 'C › D' }] });
        expect(r.channels[0]).toEqual(expect.objectContaining({ marketplace: 'mercadolibre', status: 'error', accounts: 0 }));
        expect(c.sync.enqueuePublish).not.toHaveBeenCalled();
    });

    it('con la categoría elegida por la persona la usa, descarta los atributos de la anterior y publica', async () => {
        const c = construir({
            producto: { id: 'p1', sku: 'CO252', price: 20, name: 'DESMENUZADOR', description: 'texto', aiAttributes: { mercadolibre_category_id: 'MPE9', mercadolibre_attributes: { VIEJO: 'x' } }, marketplaceIds: {} },
        });
        const r = await c.service.lanzar(SCOPE, 'p1', ['mercadolibre'], {}, { meliCategoryId: 'MPE444279' });

        expect(c.producto.aiAttributes.mercadolibre_category_id).toBe('MPE444279');
        expect(c.producto.aiAttributes.mercadolibre_attributes.VIEJO).toBeUndefined();
        expect(r.meliCategory).toEqual({ id: 'MPE444279', path: 'Ruta › MPE444279' });
        expect(c.sync.enqueuePublish).toHaveBeenCalled();
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

describe('lanzar un producto con variantes', () => {
    const variante = (id: string, sku: string, extra: any = {}) => ({
        id, sku, price: 39.9, name: 'Perchero', aiTitle: 'Perchero Metal',
        marketplaceIds: { mercadolibre_category_id: 'MPE1' }, aiAttributes: { brand: 'GENERICO', mercadolibre_attributes: { COLOR: 'Azul', MATERIAL: 'Metal' } }, ...extra,
    });

    it('prepara y publica cada variante del grupo, no solo la que se pulsó', async () => {
        const familia = [variante('v1', 'OG144'), variante('v2', 'OG146')];
        const { service, sync, falabellaPrep } = construir({ familia, producto: familia[0] });
        const r = await service.lanzar(SCOPE, 'v1', ['falabella', 'mercadolibre'], { falabella: ['fa1'], mercadolibre: ['ml1'] });

        expect(falabellaPrep.preparar.mock.calls.map((c: any[]) => c[1])).toEqual(['v1', 'v2']);
        expect(sync.enqueuePublish.mock.calls.map((c: any[]) => [c[1], c[2][0]])).toEqual([['v1', 'falabella'], ['v2', 'falabella'], ['v1', 'mercadolibre'], ['v2', 'mercadolibre']]);
        expect(r.channels).toEqual([
            { marketplace: 'falabella', accounts: 1, status: 'encolado', message: 'Publicando 2 variantes en Falabella.' },
            { marketplace: 'mercadolibre', accounts: 1, status: 'encolado', message: 'Publicando 2 variantes en Mercado Libre.' },
        ]);
    });

    it('si una variante no está lista para Falabella no se envía ninguna y se dice cuál', async () => {
        const familia = [variante('v1', 'OG144'), variante('v2', 'OG146')];
        const { service, sync, falabellaPrep } = construir({ familia, producto: familia[0] });
        falabellaPrep.preparar.mockImplementation(async (_s: any, id: string) => (id === 'v2' ? { listo: false, motivo: 'le faltan las medidas' } : { listo: true }));
        const r = await service.lanzar(SCOPE, 'v1', ['falabella'], { falabella: ['fa1'] });

        expect(sync.enqueuePublish).not.toHaveBeenCalled();
        expect(r.channels[0]).toMatchObject({ status: 'error', message: expect.stringContaining('OG146 le faltan las medidas') });
    });

    it('una variante sin precio frena el lanzamiento del grupo entero', async () => {
        const familia = [variante('v1', 'OG144'), variante('v2', 'OG146', { price: 0 })];
        const { service, sync } = construir({ familia, producto: familia[0] });
        const r = await service.lanzar(SCOPE, 'v1', ['mercadolibre'], { mercadolibre: ['ml1'] });
        expect(sync.enqueuePublish).not.toHaveBeenCalled();
        expect(r.channels[0].message).toContain('OG146');
    });
});

describe('categoría de Mercado Libre elegida sola', () => {
    it('una de «Antigüedades» no se usa para un producto nuevo: se ofrecen las demás y la persona elige', async () => {
        const { service, sync } = construir({ ruta: 'Antigüedades y Colecciones › Antigüedades › Percheros' });
        sync.suggestMeliCategories.mockResolvedValue([{ id: 'MPE9', path: 'Antigüedades y Colecciones › Otras' }, { id: 'MPE5', path: 'Hogar › Percheros' }]);
        const r = await service.lanzar(SCOPE, 'p1', ['mercadolibre'], { mercadolibre: ['ml1'] });
        expect(sync.enqueuePublish).not.toHaveBeenCalled();
        expect(r.channels[0]).toMatchObject({ status: 'error' });
        expect(r.meliCategory).toEqual({ options: [{ id: 'MPE5', path: 'Hogar › Percheros' }] });
    });

    it('si la persona la eligió, se respeta aunque sea de Antigüedades', async () => {
        const { service, sync } = construir({ ruta: 'Antigüedades y Colecciones › Antigüedades › Percheros' });
        await service.lanzar(SCOPE, 'p1', ['mercadolibre'], { mercadolibre: ['ml1'] }, { meliCategoryId: 'MPE444184' });
        expect(sync.enqueuePublish).toHaveBeenCalled();
    });
});

describe('categoría elegida por la persona', () => {
    it('reemplaza también la que ya estaba en marketplaceIds, que es la que se usa al publicar', async () => {
        const producto = {
            id: 'p1', price: 40, name: 'Perchero', aiTitle: 'Perchero Metal', description: 'texto',
            marketplaceIds: { mercadolibre_category_id: 'MPE444184' }, aiAttributes: { brand: 'GENERICO', mercadolibre_category_id: 'MPE444184', mercadolibre_attributes: { COLOR: 'Azul' } },
        };
        const { service } = construir({ producto });
        await service.lanzar(SCOPE, 'p1', ['mercadolibre'], { mercadolibre: ['ml1'] }, { meliCategoryId: 'MPE436429' });
        expect(producto.marketplaceIds.mercadolibre_category_id).toBe('MPE436429');
        expect(producto.aiAttributes.mercadolibre_category_id).toBe('MPE436429');
    });
});

describe('categoría de Falabella de un grupo', () => {
    it('las demás variantes usan la categoría elegida para la primera, salvo una puesta a mano', async () => {
        const v = (id: string, extra: any = {}) => ({ id, sku: id, price: 10, name: id, marketplaceIds: { falabella_category_id: '3169' }, aiAttributes: { brand: 'X', ...extra } });
        const familia = [v('v1'), v('v2'), v('v3', { _categoriaManual: '3169' })];
        const { service, sync, falabellaPrep } = construir({ familia, producto: familia[0] });
        sync.findScopedProduct.mockImplementation(async (_s: any, id: string) => familia.find((f) => f.id === id));
        falabellaPrep.preparar.mockImplementation(async (_s: any, id: string) => ({ listo: true, category: { id: '5000', path: 'x', auto: true } }));

        await service.lanzar(SCOPE, 'v1', ['falabella'], { falabella: ['fa1'] });

        expect((familia[1].marketplaceIds as any).falabella_category_id).toBe('5000');
        expect((familia[1].aiAttributes as any)._categoriaVerificada).toBe('5000');
        expect((familia[2].marketplaceIds as any).falabella_category_id).toBe('3169'); // la eligió una persona
    });
});

describe('revisar antes de publicar', () => {
    const grupo = { name: 'Perchero Elegante Multifuncional Kasari Metal Negro Azul', parentSku: 'PERCHERO-METAL', axes: [{ name: 'Color', values: ['Negro', 'Celeste'] }] };
    const variante = (id: string, sku: string, color: string) => ({
        id, sku, price: 39.9, stock: 10, name: `${grupo.name} - ${color}`, aiTitle: 'título viejo cortado', group: grupo, variantValues: { Color: color },
        marketplaceIds: { mercadolibre_category_id: 'MPE1' }, aiAttributes: { brand: 'GENERICO', mercadolibre_attributes: { COLOR: 'Azul', MATERIAL: 'Metal' } },
    });

    it('con soloPreparar deja todo listo y NO publica nada, y dice cómo saldría cada variante', async () => {
        const familia = [variante('v1', 'OG144', 'Negro'), variante('v2', 'OG146', 'Celeste')];
        const { service, sync, falabellaPrep } = construir({ familia, producto: familia[0] });
        const r = await service.lanzar(SCOPE, 'v1', ['falabella', 'mercadolibre'], { falabella: ['fa1'], mercadolibre: ['ml1'] }, { soloPreparar: true });

        expect(sync.enqueuePublish).not.toHaveBeenCalled();
        expect(falabellaPrep.preparar).toHaveBeenCalledTimes(2); // sí se prepara: categoría, medidas, atributos
        expect(r.channels.map((c) => c.status)).toEqual(['preparado', 'preparado']);
        expect(r.channels[0].message).toContain('2 variantes');
        expect(r.variants).toEqual([
            { id: 'v1', sku: 'OG144', etiqueta: 'Negro', price: 39.9, stock: 10, titulos: { falabella: 'Perchero Elegante Multifuncional Kasari Metal - Negro', mercadolibre: 'Perchero Elegante Multifuncional Kasari Metal Negro' } },
            { id: 'v2', sku: 'OG146', etiqueta: 'Celeste', price: 39.9, stock: 10, titulos: { falabella: 'Perchero Elegante Multifuncional Kasari Metal - Celeste', mercadolibre: 'Perchero Elegante Multifuncional Kasari Metal Celeste' } },
        ]);
    });

    it('si falta algo, soloPreparar lo dice igual que al publicar', async () => {
        const familia = [variante('v1', 'OG144', 'Negro'), variante('v2', 'OG146', 'Celeste')];
        const { service, falabellaPrep } = construir({ familia, producto: familia[0] });
        falabellaPrep.preparar.mockImplementation(async (_s: any, id: string) => (id === 'v2' ? { listo: false, motivo: 'le faltan las medidas' } : { listo: true }));
        const r = await service.lanzar(SCOPE, 'v1', ['falabella'], { falabella: ['fa1'] }, { soloPreparar: true });
        expect(r.channels[0]).toMatchObject({ status: 'error', message: expect.stringContaining('OG146 le faltan las medidas') });
    });

    it('un producto simple muestra su título tal cual', async () => {
        const { service } = construir();
        const r = await service.lanzar(SCOPE, 'p1', ['mercadolibre'], { mercadolibre: ['ml1'] }, { soloPreparar: true });
        expect(r.variants).toHaveLength(1);
        expect(r.variants![0].etiqueta).toBeNull();
        expect(r.variants![0].titulos.mercadolibre).toBe('Torre Montessori');
    });
});
