import { FalabellaAutoPrepService } from './falabella-auto-prep.service';

function construir(producto: any, opts: { marcas?: string[]; categoriaElegida?: string | null } = {}) {
    const guardados: any[] = [];
    const sync: any = {
        findScopedProduct: jest.fn(async () => producto),
        familiaDe: jest.fn(async () => [producto]),
        falabellaCategoryVariants: jest.fn(async () => ({ admiteVariantes: false })),
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
        elegirCategoriaVerificada: jest.fn(async () => {
            const id = opts.categoriaElegida === undefined ? '2804' : opts.categoriaElegida;
            return id ? { id, confianza: 'alta', ruta: 'Juguetes › Didácticos' } : { id: null, confianza: 'ninguna', motivo: 'ninguna encaja' };
        }),
        verificarCategoria: jest.fn(async () => ({ ok: true, motivo: '' })),
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
    const publicado = (): any => ({ ...producto(), aiAttributes: { brand: 'GENERICO', descriptionHtml: '<div>vieja</div>' }, marketplaceIds: { falabella_category_id: '2804' }, packageWidth: 1, packageLength: 1, packageHeight: 1, packageWeight: 1 });

    it('actualizar una ficha ya publicada vuelve a redactar con la IA si se pide, lo guarda en Synkro y NO envía nada al canal', async () => {
        const { service, guardados, sync, ai } = construir(publicado());
        const r: any = await service.actualizarEnFalabella({ userId: 'u', storeId: 's' }, 'p1', { regenerar: true });
        expect(ai.generarDescripcionHtml).toHaveBeenCalledTimes(1);
        expect(guardados[0].aiAttributes.descriptionHtml).toBe('<div>ficha</div>');
        expect(sync.updateFalabellaContent).not.toHaveBeenCalled();
        expect(r.sent).toBe(false);
        expect(r.message).toMatch(/no se envió nada/i);
        expect(r.report.attributes).toEqual({ filled: expect.any(Number), total: 2 });
    });

    it('sin indicar nada tampoco se envía: preparar es lo que ocurre por defecto', async () => {
        const { service, sync } = construir(publicado());
        const r: any = await service.actualizarEnFalabella({ userId: 'u', storeId: 's' }, 'p1');
        expect(sync.updateFalabellaContent).not.toHaveBeenCalled();
        expect(r.sent).toBe(false);
    });

    it('enviar manda a Falabella lo que el producto tiene ahora, sin volver a pasar por la IA ni cambiar nada', async () => {
        const { service, guardados, sync, ai } = construir(publicado());
        const r: any = await service.actualizarEnFalabella({ userId: 'u', storeId: 's' }, 'p1', { enviar: true, regenerar: true });
        expect(sync.updateFalabellaContent).toHaveBeenCalledTimes(1);
        expect(ai.generarDescripcionHtml).not.toHaveBeenCalled();
        expect(ai.completarAtributos).not.toHaveBeenCalled();
        expect(guardados).toHaveLength(0);
        expect(r).toMatchObject({ message: 'enviado', sent: true });
    });

    it('elige categoría, cambia una marca inexistente por GENERICO, estima medidas y completa lo obligatorio', async () => {
        const { service, guardados, ai, canales } = construir(producto());
        const r = await service.preparar({ userId: 'u', storeId: 's' }, 'p1');

        expect(r.category).toEqual({ id: '2804', path: 'Juguetes › Didácticos', auto: true, confidence: 'alta' });
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
        expect(ai.elegirCategoriaVerificada).not.toHaveBeenCalled();
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

describe('un producto con variantes prefiere una categoría que admita variantes', () => {
    const SCOPE = { userId: 'u', storeId: 's' };
    const grupo = (extra: any = {}) => ({ ...producto(), id: 'g1', marketplaceIds: { falabella_category_id: '3169' }, aiAttributes: { brand: 'GENERICO' }, ...extra });

    /** `admiten`: ids de categoría que admiten variantes; `buenas`: las que la IA da por correctas para el producto. */
    function conVariantes(p: any, admiten: string[], buenas: string[], candidatas: { categoryId: string; name: string }[]) {
        const t = construir(p);
        t.sync.familiaDe.mockResolvedValue([p, { ...p, id: 'g2' }]);
        t.sync.falabellaCategoryVariants.mockImplementation(async (_s: any, id: string) => ({ admiteVariantes: admiten.includes(String(id)) }));
        t.ai.verificarCategoria.mockImplementation(async (_n: string, _d: string, _v: any, ruta: string) => ({ ok: buenas.some((b) => ruta.includes(b)), motivo: '' }));
        t.canales.candidatasFalabella.mockResolvedValue(candidatas);
        return t;
    }

    it('si la categoría no las admite y hay una parecida y verificada que sí, usa esa', async () => {
        const p = grupo();
        const { service } = conVariantes(p, ['5000'], ['Percheros', 'Colgadores'], [
            { categoryId: '3169', name: 'Hogar › Percheros | Colgadores de ropa' },
            { categoryId: '4999', name: 'Hogar › Organizadores' }, // admite variantes, pero la IA dice que no corresponde
            { categoryId: '5000', name: 'Hogar › Percheros con variantes' },
        ]);
        (service as any).falabella.getCategories = jest.fn(async () => []);
        const r = await service.preparar(SCOPE, 'g1');
        expect(r.category).toMatchObject({ id: '5000', auto: true });
        expect(p.marketplaceIds.falabella_category_id).toBe('5000');
    });

    it('si ninguna parecida las admite, conserva la suya y cada variante saldrá como ficha suelta', async () => {
        const p = grupo();
        const { service } = conVariantes(p, [], ['Percheros'], [{ categoryId: '3169', name: 'Hogar › Percheros' }, { categoryId: '6000', name: 'Hogar › Otro Percheros' }]);
        const r = await service.preparar(SCOPE, 'g1');
        expect(r.category?.id).toBe('3169');
    });

    it('una categoría que eligió una persona no se cambia', async () => {
        const p = grupo({ aiAttributes: { brand: 'GENERICO', _categoriaManual: '3169' } });
        const { service, sync } = conVariantes(p, ['5000'], ['Percheros'], [{ categoryId: '5000', name: 'Hogar › Percheros con variantes' }]);
        const r = await service.preparar(SCOPE, 'g1');
        expect(r.category).toMatchObject({ id: '3169', confidence: 'manual' });
        expect(sync.falabellaCategoryVariants).not.toHaveBeenCalled();
    });

    it('un producto sin variantes ni consulta si la categoría las admite', async () => {
        const p = grupo();
        const { service, sync } = conVariantes(p, ['5000'], ['Percheros'], []);
        sync.familiaDe.mockResolvedValue([p]);
        await service.preparar(SCOPE, 'g1');
        expect(sync.falabellaCategoryVariants).not.toHaveBeenCalled();
    });
});
