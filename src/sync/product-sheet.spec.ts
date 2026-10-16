import { ProductSheetService } from './product-sheet.service';

function construir(producto: any, enlaces: any[] = []) {
    const guardados: any[] = [];
    const sync: any = {
        findScopedProduct: jest.fn(async () => producto),
        scheduleContentSync: jest.fn(async () => enlaces.filter((e) => e.syncStatus === 'published').map((e) => ({ marketplace: e.marketplace, connectionId: e.connection.id }))),
        credentialsOf: jest.fn(() => ({ userId: 'x', apiKey: 'k' })),
        categoriaFalabella: jest.fn((p: any) => p.marketplaceIds?.falabella_category_id),
        toFalabellaInput: jest.fn(() => ({ reason: 'le faltan datos' })),
        nombreParaFalabella: jest.fn((n: string) => n.slice(0, 100)),
        buscarAtributo: jest.fn((a: any, n: string) => a[n]),
        atributosParaMeli: jest.fn(() => [{ id: 'BRAND', value_name: 'GENERICO' }, { id: 'COLOR', value_name: 'Azul' }]),
        runContentSync: jest.fn(async () => ({ ok: true, message: 'ok' })),
    };
    const falabella: any = {
        getCategoryAttributes: jest.fn(async () => [
            { name: 'material', feedName: 'Material', label: 'Material', description: 'Del cuerpo', isMandatory: true, inputType: 'singleSelect', options: ['Madera'] },
            { name: 'garantia', feedName: 'Garantia', label: 'Garantía', description: '', isMandatory: false, inputType: 'textField', options: [] },
            { name: 'brand', feedName: 'Brand', label: 'Marca', description: '', isMandatory: true, inputType: 'textField', options: [] },
        ]),
        getCategories: jest.fn(async () => [{ id: '956', path: 'Juguetes › Torres' }]),
    };
    const links: any = { find: jest.fn(async () => enlaces) };
    const products: any = { save: jest.fn(async (p: any) => { guardados.push(JSON.parse(JSON.stringify(p))); return p; }) };
    return { service: new ProductSheetService(sync, falabella, links, products), sync, guardados };
}

const SCOPE = { userId: 'u1', storeId: 't1' };
const producto = () => ({
    id: 'p1', sku: 'MK-1', name: 'Torre', description: 'texto', aiTitle: 'Torre Montessori 4 en 1', aiDescription: 'desc', price: 480, stock: 5,
    packageWidth: 45, packageLength: 40, packageHeight: 90, packageWeight: 9, images: [{ url: 'https://i/1.jpg' }],
    marketplaceIds: { falabella_category_id: '956' },
    aiAttributes: { brand: 'GENERICO', material: 'Madera', descriptionHtml: '<div>h</div>', estimated: { measures: true, attributes: {} } },
});
const enlace = (marketplace: string, over: any = {}) => ({
    marketplace, syncStatus: 'published', lastError: null, permalink: 'https://x',
    connection: { id: `c-${marketplace}`, label: 'Mi cuenta', store: { id: 't1' }, externalUserId: 'x' }, ...over,
});

describe('la ficha de un producto', () => {
    it('muestra lo que se envía a cada canal donde está publicado, con sus atributos y si ya puede salir', async () => {
        const { service } = construir(producto(), [enlace('falabella'), enlace('mercadolibre'), enlace('falabella', { connection: { id: 'otra', store: { id: 'otra-tienda' } } })]);
        const hoja = await service.getSheet(SCOPE, 'p1');

        expect(hoja.product).toMatchObject({ sku: 'MK-1', brand: 'GENERICO', descriptionHtml: '<div>h</div>', measures: { width: 45, estimated: true } });
        expect(hoja.channels.map((c) => c.marketplace)).toEqual(['falabella', 'mercadolibre']);

        const fal = hoja.channels[0];
        expect(fal.sent).toMatchObject({ name: 'Torre Montessori 4 en 1', isHtml: true, categoryPath: 'Juguetes › Torres', brand: 'GENERICO' });
        // el obligatorio primero; lo que la plataforma ya cubre (marca) no se repite
        expect(fal.sent.attributes.map((a: any) => a.name)).toEqual(['material', 'garantia']);
        expect(fal.sent.attributes[0]).toMatchObject({ required: true, value: 'Madera', options: ['Madera'] });
        expect(fal.listo).toBe(false);
        expect(fal.motivo).toBe('le faltan datos');

        expect(hoja.channels[1].sent).toMatchObject({ title: 'Torre Montessori 4 en 1', titleEditable: false, attributes: [{ id: 'BRAND', value: 'GENERICO' }, { id: 'COLOR', value: 'Azul' }] });
    });

    it('guardar cambia solo lo enviado, marca las medidas como revisadas y programa el envío a los canales publicados', async () => {
        const { service, sync, guardados } = construir(producto(), [enlace('falabella'), enlace('mercadolibre', { syncStatus: 'pending' })]);
        const r = await service.saveSheet(SCOPE, 'p1', {
            aiTitle: 'Nuevo título', descriptionHtml: '', attributes: { garantia: '12 meses', material: '' },
            mercadolibreAttributes: { COLOR: 'Rojo' }, measures: { width: 50, length: 40, height: 90, weight: 10 },
        });

        expect(r).toEqual({ saved: true, willUpdate: ['falabella'] });
        expect(sync.scheduleContentSync).toHaveBeenCalledWith('p1');
        const g = guardados[0];
        expect(g.aiTitle).toBe('Nuevo título');
        expect(g.name).toBe('Torre');
        expect(g.aiAttributes.descriptionHtml).toBeUndefined();
        expect(g.aiAttributes.material).toBeUndefined();
        expect(g.aiAttributes.garantia).toBe('12 meses');
        expect(g.aiAttributes.mercadolibre_attributes).toEqual({ COLOR: 'Rojo' });
        expect(g.packageWidth).toBe(50);
        expect(g.aiAttributes.estimated.measures).toBe(false);
    });

    it('no deja guardar un nombre vacío', async () => {
        const { service, guardados } = construir(producto());
        await expect(service.saveSheet(SCOPE, 'p1', { name: '   ' })).rejects.toThrow(/no puede quedar vacío/);
        expect(guardados).toHaveLength(0);
    });

    it('enviar ya manda el contenido a cada canal publicado de esta tienda', async () => {
        const { service, sync } = construir(producto(), [enlace('falabella'), enlace('mercadolibre'), enlace('falabella', { connection: { id: 'otra', store: { id: 'otra-tienda' } } })]);
        const r = await service.syncNow(SCOPE, 'p1');
        expect(sync.runContentSync).toHaveBeenCalledTimes(2);
        expect(r.results.map((x) => x.marketplace)).toEqual(['falabella', 'mercadolibre']);
    });
});
