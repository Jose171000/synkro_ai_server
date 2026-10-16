import { FalabellaAutoPrepService } from './falabella-auto-prep.service';

function construir(producto: any, opts: { marcas?: string[]; categoriaElegida?: string | null } = {}) {
    const guardados: any[] = [];
    const sync: any = {
        findScopedProduct: jest.fn(async () => producto),
        resolveConnection: jest.fn(async () => ({ id: 'c1' })),
        credentialsOf: jest.fn(() => ({ userId: 'x', apiKey: 'k' })),
        categoriaFalabella: jest.fn((p: any) => p.marketplaceIds?.falabella_category_id),
        buscarAtributo: jest.fn((a: any, n: string) => a[n]),
        nombreParaFalabella: jest.fn((n: string) => n.slice(0, 100)),
        updateFalabellaContent: jest.fn(async () => ({ message: 'enviado', feedId: 'f1' })),
        toFalabellaInput: jest.fn((p: any) => (p.packageWidth && p.marketplaceIds?.falabella_category_id ? { input: {} } : { reason: 'le faltan datos' })),
    };
    const indice = new Map((opts.marcas ?? ['Fisher-Price']).map((m) => [m.toLowerCase(), m]));
    const falabella: any = {
        brandsIndex: jest.fn(async () => indice),
        getCategoryAttributes: jest.fn(async () => []),
        getCategories: jest.fn(async () => [{ id: '2804', path: 'Juguetes › Didácticos' }]),
    };
    const ai: any = {
        elegirCategoria: jest.fn(async () => (opts.categoriaElegida === undefined ? '2804' : opts.categoriaElegida)),
        estimarPaquete: jest.fn(async () => ({ width: 30, length: 40, height: 20, weight: 3, fromClient: false })),
        generarDescripcionHtml: jest.fn(async () => ({ html: '<div>ficha</div>', title: 'Torre de aprendizaje Montessori de madera 4 en 1' })),
        completarAtributos: jest.fn(async () => ({ values: { material: 'Madera' }, estimated: ['material'] })),
    };
    const canales: any = {
        candidatasFalabella: jest.fn(async () => [{ categoryId: '2804', name: 'Juguetes › Didácticos' }]),
        requisitos: jest.fn(async () => [
            { name: 'material', description: 'Material', example: '', isRequired: true },
            { name: 'color', description: 'Color', example: '', isRequired: false },
        ]),
    };
    const vectores: any = { findSimilarCategories: jest.fn(async () => []) };
    const seeder: any = { generateEmbedding: jest.fn(async () => [0.1]) };
    const products: any = { save: jest.fn(async (p: any) => { guardados.push(JSON.parse(JSON.stringify(p))); return p; }) };
    return { service: new FalabellaAutoPrepService(sync, falabella, ai, canales, vectores, seeder, products), ai, guardados, canales, sync };
}

const producto = () => ({
    id: 'p1', name: 'Torre de aprendizaje Montessori', aiTitle: null, description: 'Torre de madera', aiDescription: null,
    packageWidth: null, packageLength: null, packageHeight: null, packageWeight: null,
    marketplaceIds: {}, aiAttributes: { brand: 'Marca Inventada' },
});

describe('dejar un producto listo para Falabella con un paso', () => {
    it('actualizar una ficha ya publicada vuelve a redactar con la IA si se pide y envía el contenido', async () => {
        const p: any = { ...producto(), aiAttributes: { brand: 'GENERICO', descriptionHtml: '<div>vieja</div>' }, marketplaceIds: { falabella_category_id: '2804' }, packageWidth: 1, packageLength: 1, packageHeight: 1, packageWeight: 1 };
        const { service, guardados, sync, ai } = construir(p);
        const r = await service.actualizarEnFalabella({ userId: 'u', storeId: 's' }, 'p1', { regenerar: true });
        expect(ai.generarDescripcionHtml).toHaveBeenCalledTimes(1);
        expect(guardados[0].aiAttributes.descriptionHtml).toBe('<div>ficha</div>');
        expect(sync.updateFalabellaContent).toHaveBeenCalledTimes(1);
        expect(r.message).toBe('enviado');
        expect(r.report.attributes).toEqual({ filled: expect.any(Number), total: 2 });
    });

    it('elige categoría, cambia una marca inexistente por GENERICO, estima medidas y completa lo obligatorio', async () => {
        const { service, guardados, ai, canales } = construir(producto());
        const r = await service.preparar({ userId: 'u', storeId: 's' }, 'p1');

        expect(r.category).toEqual({ id: '2804', path: 'Juguetes › Didácticos', auto: true });
        expect(r.brand).toEqual({ value: 'GENERICO', replaced: true, original: 'Marca Inventada' });
        expect(r.measures).toMatchObject({ width: 30, weight: 3, estimated: true });
        expect(r.estimatedAttributes).toEqual(['material']);
        // Se piden TODOS los atributos de la categoría (también los opcionales que suben la calidad)
        expect(ai.completarAtributos.mock.calls[0][2].map((a: any) => a.name)).toEqual(['material', 'color']);
        expect(canales.requisitos.mock.calls[0][5]).toEqual({ todos: true });
        expect(r.descriptionGenerated).toBe(true);
        expect(guardados[0].aiAttributes.descriptionHtml).toBe('<div>ficha</div>');
        expect(r.listo).toBe(true);
        expect(guardados[0].aiAttributes).toMatchObject({ brand: 'GENERICO', material: 'Madera', estimated: { measures: true } });
        expect(guardados[0].marketplaceIds.falabella_category_id).toBe('2804');
    });

    it('respeta una marca del catálogo (con su escritura) y lo que el producto ya tiene', async () => {
        const p: any = { ...producto(), aiAttributes: { brand: 'fisher-price', material: 'Plástico', color: 'Azul', descriptionHtml: '<div>ya</div>' }, packageWidth: 10, packageLength: 10, packageHeight: 10, packageWeight: 1, marketplaceIds: { falabella_category_id: '999' } };
        const { service, ai, canales } = construir(p);
        const r = await service.preparar({ userId: 'u', storeId: 's' }, 'p1');

        expect(r.brand).toEqual({ value: 'Fisher-Price', replaced: false });
        expect(r.category!.id).toBe('999');
        expect(r.category!.auto).toBe(false);
        expect(r.measures.estimated).toBe(false);
        expect(ai.elegirCategoria).not.toHaveBeenCalled();
        expect(ai.estimarPaquete).not.toHaveBeenCalled();
        expect(ai.completarAtributos).not.toHaveBeenCalled();
        expect(ai.generarDescripcionHtml).not.toHaveBeenCalled();
        expect(canales.requisitos).toHaveBeenCalled();
    });

    it('si no logra elegir categoría lo dice y no está listo', async () => {
        const { service } = construir(producto(), { categoriaElegida: null });
        const r = await service.preparar({ userId: 'u', storeId: 's' }, 'p1');
        expect(r.category).toBeNull();
        expect(r.listo).toBe(false);
    });
});
