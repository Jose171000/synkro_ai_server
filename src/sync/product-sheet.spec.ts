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
        programarEnvioDeInventario: jest.fn(async () => undefined),
    };
    const falabella: any = {
        getCategoryAttributes: jest.fn(async () => [
            { name: 'material', feedName: 'Material', label: 'Material', description: 'Del cuerpo', isMandatory: true, inputType: 'singleSelect', options: ['Madera'] },
            { name: 'garantia', feedName: 'Garantia', label: 'Garantía', description: '', isMandatory: false, inputType: 'textField', options: [] },
            { name: 'brand', feedName: 'Brand', label: 'Marca', description: '', isMandatory: true, inputType: 'textField', options: [] },
        ]),
        getCategories: jest.fn(async () => [{ id: '956', path: 'Juguetes › Torres' }]),
    };
    const links: any = {
        find: jest.fn(async () => enlaces),
        findOne: jest.fn(async ({ where }: any) => enlaces.find((e) => e.connection.id === where.connection.id) ?? null),
        save: jest.fn(async (e: any) => e),
    };
    const products: any = { save: jest.fn(async (p: any) => { guardados.push(JSON.parse(JSON.stringify(p))); return p; }), findOne: jest.fn(async () => ({ id: producto.id, group: producto.groupDelTest ?? null })) };
    return { service: new ProductSheetService(sync, falabella, links, products), sync, guardados, links };
}

const SCOPE = { userId: 'u1', storeId: 't1' };

/** Guardar lo común de un grupo de variantes en todas a la vez. */
describe('ficha de un grupo de variantes', () => {
    const grupo = { id: 'g1', name: 'Sandalias de cuero', parentSku: 'SAN', axes: [{ name: 'Color', values: ['Negro', 'Beige'] }, { name: 'Talla', values: ['35', '36'] }] };
    const variante = (id: string, color: string, talla: string) => ({
        id, sku: `SAN-${id}`, name: `Sandalias de cuero - ${color} · ${talla}`, description: 'texto', aiTitle: `Sandalias de cuero - ${color} · ${talla}`, aiDescription: 'vieja', price: 200, stock: 3, images: [],
        group: grupo, variantValues: { Color: color, Talla: talla },
        aiAttributes: { brand: 'GENERICO', Color: color, color: color, color_basico: color, talla, material_principal: 'Cuero', garantia: '1 mes' },
    });
    const armar = (variantes: any[]) => {
        const guardados: any[] = [];
        const sync: any = {
            findScopedProduct: jest.fn(async (_s: any, id: string) => variantes.find((v) => v.id === id)),
            scheduleContentSync: jest.fn(async () => [{ marketplace: 'falabella', connectionId: 'c1' }]),
        };
        const products: any = {
            find: jest.fn(async () => variantes),
            save: jest.fn(async (p: any) => { guardados.push(JSON.parse(JSON.stringify(p))); return p; }),
            manager: { update: jest.fn(async () => undefined) },
        };
        const service = new ProductSheetService(sync, {} as any, {} as any, products);
        return { service, sync, products, guardados };
    };

    it('aplica lo común a todas las variantes y deja lo propio de cada una (nombre interno, color, talla, precio)', async () => {
        const { service, guardados } = armar([variante('a', 'Negro', '35'), variante('b', 'Beige', '36')]);
        const r = await service.saveGroupSheet(SCOPE, 'g1', {
            name: 'No debe pasar', aiDescription: 'Nueva descripción', descriptionHtml: '<p>HTML común</p>', brand: 'JOLI JOLI',
            attributes: { garantia: '3 meses', color: 'Rojo', color_basico: 'Rojo', talla: '40', Color: 'Rojo' },
            prices: [{ connectionId: 'c1', price: 1 }] as any,
        });
        expect(r).toMatchObject({ saved: true, variantes: 2, willUpdate: ['falabella'] });
        expect(guardados).toHaveLength(2);
        for (const g of guardados) {
            expect(g.aiDescription).toBe('Nueva descripción');
            expect(g.aiAttributes.descriptionHtml).toBe('<p>HTML común</p>');
            expect(g.aiAttributes.brand).toBe('JOLI JOLI');
            expect(g.aiAttributes.garantia).toBe('3 meses');
            expect(g.name).toMatch(/ - (Negro|Beige) · /); // el nombre interno no cambia
            expect(g.price).toBe(200);
        }
        // Lo propio de cada variante se conserva.
        expect(guardados[0].aiAttributes).toMatchObject({ color: 'Negro', color_basico: 'Negro', talla: '35', Color: 'Negro' });
        expect(guardados[1].aiAttributes).toMatchObject({ color: 'Beige', color_basico: 'Beige', talla: '36', Color: 'Beige' });
    });

    it('el título común es también el nombre del grupo, y el envío se programa una vez por variante, escalonado', async () => {
        const { service, sync, products } = armar([variante('a', 'Negro', '35'), variante('b', 'Beige', '36'), variante('c', 'Negro', '36')]);
        await service.saveGroupSheet(SCOPE, 'g1', { aiTitle: '  Sandalias floater JOLI JOLI  ' });
        expect(products.manager.update).toHaveBeenCalledWith('product_groups', { id: 'g1' }, { name: 'Sandalias floater JOLI JOLI' });
        expect(sync.scheduleContentSync.mock.calls.map((c: any[]) => [c[0], c[1]])).toEqual([['a', 45000], ['b', 49000], ['c', 53000]]);
    });

    it('solo se guarda lo que viene: lo que no se tocó se conserva en cada variante', async () => {
        const v = variante('a', 'Negro', '35');
        v.aiAttributes.material_principal = 'Gamuza'; // personalizada
        const { service, guardados } = armar([v, variante('b', 'Beige', '36')]);
        await service.saveGroupSheet(SCOPE, 'g1', { brand: 'JOLI JOLI' });
        expect(guardados[0].aiAttributes.material_principal).toBe('Gamuza');
        expect(guardados[0].aiDescription).toBe('vieja');
    });

    it('sin nada común que guardar (solo color, talla, precio o nombre) lo rechaza; un grupo que no es de la tienda no existe', async () => {
        const { service } = armar([variante('a', 'Negro', '35')]);
        await expect(service.saveGroupSheet(SCOPE, 'g1', { name: 'x', attributes: { color: 'Rojo', talla: '40' }, prices: [] as any })).rejects.toThrow(/nada común/);
        const vacio = armar([]);
        await expect(vacio.service.saveGroupSheet(SCOPE, 'g-ajeno', { brand: 'X' })).rejects.toThrow(/No se encontró/);
    });
});
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

    it('sin texto de la IA muestra el que sale de la ficha HTML, y con texto propio no lo cambia', async () => {
        const sinTexto = { ...producto(), description: '', aiDescription: null, aiAttributes: { descriptionHtml: '<div><p>Proteína de suero</p></div>' } };
        const { service } = construir(sinTexto);
        expect((await service.getSheet(SCOPE, 'p1')).product.aiDescription).toBe('Proteína de suero');

        const { service: conTexto } = construir(producto());
        expect((await conTexto.getSheet(SCOPE, 'p1')).product.aiDescription).toBe('desc');
    });

    it('guardar cambia solo lo enviado, marca las medidas como revisadas y programa el envío a los canales publicados', async () => {
        const { service, sync, guardados } = construir(producto(), [enlace('falabella'), enlace('mercadolibre', { syncStatus: 'pending' })]);
        const r = await service.saveSheet(SCOPE, 'p1', {
            aiTitle: 'Nuevo título', descriptionHtml: '', attributes: { garantia: '12 meses', material: '' },
            mercadolibreAttributes: { COLOR: 'Rojo' }, measures: { width: 50, length: 40, height: 90, weight: 10 },
        });

        expect(r).toEqual({ saved: true, willUpdate: ['falabella'], pricesSent: [] });
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

    it('etiqueta lo que escribió la IA y lo que trajo el canal, en los campos generales y en los atributos de cada canal', async () => {
        const p: any = {
            ...producto(),
            aiAttributes: {
                brand: 'MUTANT', material: 'Madera', garantia: '12 meses', descriptionHtml: '<div>h</div>',
                _ia: ['aiTitle', 'descriptionHtml'],
                _importado: { falabella: { brand: 'MUTANT', attributes: { Material: 'Madera' } }, mercadolibre: { attributes: { BRAND: 'GENERICO' } } },
                estimated: { measures: false, attributes: { falabella: ['garantia'], mercadolibre: ['COLOR'] } },
            },
        };
        const { service } = construir(p, [enlace('falabella'), enlace('mercadolibre')]);
        const hoja: any = await service.getSheet(SCOPE, 'p1');

        expect(hoja.product.origin).toEqual({ aiTitle: 'ia', descriptionHtml: 'ia', brand: 'canal' });
        const porNombre = Object.fromEntries(hoja.channels[0].sent.attributes.map((a: any) => [a.name, a.origin]));
        expect(porNombre).toEqual({ material: 'canal', garantia: 'ia' });
        const porId = Object.fromEntries(hoja.channels[1].sent.attributes.map((a: any) => [a.id, a.origin]));
        expect(porId).toEqual({ BRAND: 'canal', COLOR: 'ia' });
    });

    it('lo que la persona edita en la ficha deja de llevar la etiqueta de la IA; lo que no toca la conserva', async () => {
        const p: any = {
            ...producto(),
            aiAttributes: { brand: 'GENERICO', garantia: '12 meses', _ia: ['aiTitle', 'aiDescription', 'brand'], estimated: { measures: false, attributes: { falabella: ['garantia', 'material'], mercadolibre: ['COLOR'] } } },
        };
        const { service, guardados } = construir(p);
        await service.saveSheet(SCOPE, 'p1', { aiTitle: 'Título escrito por mí', aiDescription: 'desc', attributes: { garantia: '24 meses' } });

        expect(guardados[0].aiAttributes._ia).toEqual(['aiDescription', 'brand']);
        expect(guardados[0].aiAttributes.estimated.attributes).toEqual({ falabella: ['material'], mercadolibre: ['COLOR'] });
    });

    it('guardar sin cambiar un campo (el diálogo reenvía lo que ya tenía) no le quita la etiqueta', async () => {
        const p: any = { ...producto(), aiAttributes: { brand: 'GENERICO', _ia: ['aiTitle', 'brand'] } };
        const { service, guardados } = construir(p);
        await service.saveSheet(SCOPE, 'p1', { aiTitle: 'Torre Montessori 4 en 1', brand: 'GENERICO' });
        expect(guardados[0].aiAttributes._ia).toEqual(['aiTitle', 'brand']);
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

describe('precios por canal en la ficha', () => {
    it('muestra por cada cuenta lo que se envía, de dónde sale y lo que el canal muestra hoy', async () => {
        const fal = enlace('falabella', { regularPrice: 500, salePrice: 450, lastStockSynced: 3 });
        const { service } = construir(producto(), [fal, enlace('mercadolibre', { priceOverride: 520 })]);
        const hoja: any = await service.getSheet(SCOPE, 'p1');
        expect(hoja.prices).toHaveLength(2);
        expect(hoja.prices[0]).toMatchObject({
            marketplace: 'falabella', productPrice: 480, canSetSale: true,
            sent: { price: 480, salePrice: 450, origin: { price: 'producto', promo: 'canal' } },
            channel: { price: 500, salePrice: 450, stock: 3 },
        });
        expect(hoja.prices[1]).toMatchObject({ marketplace: 'mercadolibre', canSetSale: false, sent: { price: 520, origin: { price: 'propio' } } });
    });

    it('guardar precios fija el de esa cuenta, lo envía a su canal y no toca el contenido', async () => {
        const fal = enlace('falabella');
        const { service, sync, links } = construir(producto(), [fal]);
        const r = await service.saveSheet(SCOPE, 'p1', { prices: [{ connectionId: 'c-falabella', price: 500, salePrice: 420, saleStart: '2026-11-01', saleEnd: '2026-11-30' }] });
        expect(r).toEqual({ saved: true, willUpdate: [], pricesSent: ['falabella'] });
        expect(links.save).toHaveBeenCalledWith(expect.objectContaining({ priceOverride: 500, salePriceOverride: 420, saleStartOverride: '2026-11-01', saleEndOverride: '2026-11-30' }));
        expect(sync.programarEnvioDeInventario).toHaveBeenCalledWith('u1', 'p1', 'falabella', 'c-falabella');
        expect(sync.scheduleContentSync).not.toHaveBeenCalled();
    });

    it('si los precios no cambiaron no envía nada, y un valor vacío vuelve a usar el del producto', async () => {
        const fal = enlace('falabella', { priceOverride: 500, salePriceOverride: 420 });
        const igual = construir(producto(), [fal]);
        await igual.service.saveSheet(SCOPE, 'p1', { prices: [{ connectionId: 'c-falabella', price: 500, salePrice: 420 }] });
        expect(igual.sync.programarEnvioDeInventario).not.toHaveBeenCalled();

        const quitar = construir(producto(), [enlace('falabella', { priceOverride: 500 })]);
        await quitar.service.saveSheet(SCOPE, 'p1', { prices: [{ connectionId: 'c-falabella', price: null }] });
        expect(quitar.links.save).toHaveBeenCalledWith(expect.objectContaining({ priceOverride: null }));
    });

    it('rechaza un descuento que no es menor que el precio y no guarda nada', async () => {
        const { service, links } = construir(producto(), [enlace('falabella')]);
        await expect(service.saveSheet(SCOPE, 'p1', { prices: [{ connectionId: 'c-falabella', price: 400, salePrice: 400 }] })).rejects.toThrow(/menor que su precio regular/);
        expect(links.save).not.toHaveBeenCalled();
    });

    it('en Mercado Libre el descuento no se guarda desde aquí', async () => {
        const { service, links } = construir(producto(), [enlace('mercadolibre')]);
        await service.saveSheet(SCOPE, 'p1', { prices: [{ connectionId: 'c-mercadolibre', price: 600, salePrice: 100 }] });
        expect(links.save).toHaveBeenCalledWith(expect.objectContaining({ priceOverride: 600, salePriceOverride: null }));
    });
});

describe('la ficha de una variante muestra lo que se envía', () => {
    const grupo = { name: 'Perchero Elegante Multifuncional Kasari Metal Negro Azul', parentSku: 'PERCHERO-METAL', axes: [{ name: 'Color', values: ['Negro', 'Celeste'] }] };

    it('en Falabella, el color de la variante (no el del molde del grupo) y el nombre que sale en el envío', async () => {
        const p: any = { ...producto(), sku: 'OG146', group: grupo, variantValues: { Color: 'Celeste' } };
        p.aiAttributes = { ...p.aiAttributes, color: 'Azul', material: 'Metal' };
        const { service, sync } = construir(p, [enlace('falabella')]);
        sync.toFalabellaInput.mockReturnValue({ input: { name: 'Perchero Elegante Multifuncional Kasari Metal - Celeste' } });
        const hoja: any = await service.getSheet(SCOPE, 'p1');
        const f = hoja.channels[0].sent;
        expect(f.name).toBe('Perchero Elegante Multifuncional Kasari Metal - Celeste');
        expect(sync.buscarAtributo.mock.calls.some(([a]: any[]) => a.color === 'Celeste')).toBe(true);
    });

    it('en Mercado Libre, el nombre común de la familia, sin colores', async () => {
        const p: any = { ...producto(), sku: 'OG146', group: grupo, variantValues: { Color: 'Celeste' } };
        const { service } = construir(p, [enlace('mercadolibre')]);
        const hoja: any = await service.getSheet(SCOPE, 'p1');
        expect(hoja.channels[0].sent.title).toBe('Perchero Elegante Multifuncional Kasari Metal');
    });
});
