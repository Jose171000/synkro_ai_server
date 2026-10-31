import { FalabellaAutoPrepService } from './falabella-auto-prep.service';

/**
 * Preparar un producto para Falabella usa todo lo que ya tiene: lo que muestran sus fotos (sin repetir el análisis si las fotos
 * no cambiaron), lo que escribió el cliente, el texto guardado y los atributos ya completados.
 */
function construir(producto: any) {
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
        toFalabellaInput: jest.fn(() => ({ input: {} })),
    };
    const falabella: any = {
        brandsIndex: jest.fn(async () => new Map([['fisher-price', 'Fisher-Price']])),
        getCategoryAttributes: jest.fn(async () => []),
        getCategories: jest.fn(async () => [{ id: '2804', path: 'Juguetes › Didácticos' }]),
    };
    const ai: any = {
        elegirCategoriaVerificada: jest.fn(async () => ({ id: '2804', confianza: 'alta' })),
        verificarCategoria: jest.fn(async () => ({ ok: true, motivo: '' })),
        estimarPaquete: jest.fn(async () => ({ width: 30, length: 40, height: 20, weight: 3 })),
        generarDescripcionHtml: jest.fn(async () => ({ html: '<div>ficha</div>', title: 'Torre de aprendizaje Montessori de madera 4 en 1', texto: 'Texto generado para canales sin HTML.' })),
        completarAtributos: jest.fn(async () => ({ values: { material: 'Madera' }, estimated: ['material'] })),
    };
    const canales: any = {
        candidatasFalabella: jest.fn(async () => [{ categoryId: '2804', name: 'Juguetes › Didácticos' }]),
        requisitos: jest.fn(async () => [{ name: 'material', description: 'Material', example: '', isRequired: true }]),
    };
    const vectores: any = { findSimilarCategories: jest.fn(async () => []) };
    const seeder: any = { generateEmbedding: jest.fn(async () => [0.1]) };
    const products: any = { save: jest.fn(async (p: any) => { guardados.push(JSON.parse(JSON.stringify(p))); return p; }) };
    const vision: any = { analyze: jest.fn(async () => ({ productType: 'torre de aprendizaje', brand: 'Fisher-Price', color: 'Azul', keywords: ['madera'] })) };
    return { service: new FalabellaAutoPrepService(sync, falabella, ai, canales, vectores, seeder, products, vision), ai, guardados, vision };
}

const SCOPE = { userId: 'u', storeId: 's' };
const producto = (extra: any = {}): any => ({
    id: 'p1', name: 'Torre de aprendizaje Montessori', aiTitle: null, description: 'Torre de madera', aiDescription: null,
    packageWidth: 1, packageLength: 1, packageHeight: 1, packageWeight: 1,
    marketplaceIds: { falabella_category_id: '2804' }, aiAttributes: {},
    images: [{ url: 'https://i/1.jpg' }, { url: 'https://i/2.jpg' }], ...extra,
});

describe('preparar usa todo lo que el producto ya tiene', () => {
    it('un producto sin visión guardada (por ejemplo, importado de un canal) tiene sus fotos analizadas y la visión llega a la ficha HTML', async () => {
        const { service, vision, ai, guardados } = construir(producto());
        await service.preparar(SCOPE, 'p1');
        expect(vision.analyze).toHaveBeenCalledTimes(1);
        expect(vision.analyze.mock.calls[0][0]).toEqual(['https://i/1.jpg', 'https://i/2.jpg']);
        expect(ai.generarDescripcionHtml.mock.calls[0][0].vision).toMatchObject({ productType: 'torre de aprendizaje' });
        expect(guardados[0].aiAttributes.vision).toMatchObject({ color: 'Azul' });
        expect(guardados[0].aiAttributes._visionFotos).toEqual(expect.any(String));
    });

    it('lo que se ve rellena la marca y el color solo si estaban vacíos', async () => {
        const { service, guardados } = construir(producto({ aiAttributes: { color: 'Rojo' } }));
        await service.preparar(SCOPE, 'p1');
        expect(guardados[0].aiAttributes.color).toBe('Rojo');
        expect(guardados[0].aiAttributes.brand).toBe('Fisher-Price');
    });

    it('con la visión vigente (mismas fotos) no se vuelve a analizar; si las fotos cambiaron, sí', async () => {
        const primero = construir(producto());
        await primero.service.preparar(SCOPE, 'p1');
        const guardado = primero.guardados[0].aiAttributes;

        const igual = construir(producto({ aiAttributes: { ...guardado } }));
        await igual.service.preparar(SCOPE, 'p1');
        expect(igual.vision.analyze).not.toHaveBeenCalled();

        const cambiadas = construir(producto({ aiAttributes: { ...guardado }, images: [{ url: 'https://i/nueva.jpg' }] }));
        await cambiadas.service.preparar(SCOPE, 'p1');
        expect(cambiadas.vision.analyze).toHaveBeenCalledTimes(1);
    });

    it('una visión de antes de que se guardara la huella se rehace una vez, y rehacer a propósito fuerza el análisis', async () => {
        const antigua = construir(producto({ aiAttributes: { vision: { productType: 'viejo' } } }));
        await antigua.service.preparar(SCOPE, 'p1');
        expect(antigua.vision.analyze).toHaveBeenCalledTimes(1);

        const forzada = construir(producto({ aiAttributes: { ...antigua.guardados[0].aiAttributes } }));
        await forzada.service.preparar(SCOPE, 'p1', undefined, { regenerar: true });
        expect(forzada.vision.analyze).toHaveBeenCalledTimes(1);
    });

    it('si el análisis de las fotos falla se conserva la visión que había y no se pierde nada', async () => {
        const { service, vision, guardados } = construir(producto({ aiAttributes: { vision: { productType: 'previo' } } }));
        vision.analyze.mockResolvedValueOnce(null);
        await service.preparar(SCOPE, 'p1');
        expect(guardados[0].aiAttributes.vision).toEqual({ productType: 'previo' });
        expect(guardados[0].aiAttributes._visionFotos).toBeUndefined();
    });

    it('un producto sin fotos no pide ningún análisis', async () => {
        const { service, vision } = construir(producto({ images: [] }));
        await service.preparar(SCOPE, 'p1');
        expect(vision.analyze).not.toHaveBeenCalled();
    });

    it('la descripción HTML se redacta DESPUÉS de completar los atributos y ya los recibe', async () => {
        const { service, ai } = construir(producto());
        await service.preparar(SCOPE, 'p1');
        expect(ai.completarAtributos.mock.invocationCallOrder[0]).toBeLessThan(ai.generarDescripcionHtml.mock.invocationCallOrder[0]);
        expect(ai.generarDescripcionHtml.mock.calls[0][0].atributos).toMatchObject({ material: 'Madera' });
    });

    it('la descripción en texto (Mercado Libre y canales sin HTML) se redacta si el producto no tenía una, y no se copia lo que escribió el cliente', async () => {
        const { service, guardados } = construir(producto({ description: 'Proteína vainilla https://giphy.com/x.gif', aiDescription: null }));
        await service.preparar(SCOPE, 'p1');
        expect(guardados[0].aiDescription).toBe('Texto generado para canales sin HTML.');
        expect(guardados[0].description).toBe('Proteína vainilla https://giphy.com/x.gif');
    });

    it('anota lo que escribió la IA para que la Ficha lo etiquete: HTML, texto y la marca que vio en las fotos', async () => {
        const { service, guardados } = construir(producto({ aiDescription: null, aiAttributes: {} }));
        await service.preparar(SCOPE, 'p1');
        expect(guardados[0].aiAttributes._ia).toEqual(expect.arrayContaining(['descriptionHtml', 'aiDescription', 'brand', 'aiTitle']));
    });

    it('lo que la IA no escribió no se anota: una descripción que ya existía y una marca que acabó siendo GENERICO', async () => {
        const { service, guardados } = construir(producto({ aiDescription: 'La real del canal', aiTitle: 'Título propio', aiAttributes: { descriptionHtml: '<div>del canal</div>', brand: 'Marca no catalogada' } }));
        await service.preparar(SCOPE, 'p1');
        const marcas = guardados[0].aiAttributes._ia ?? [];
        expect(marcas).not.toContain('aiDescription');
        expect(marcas).not.toContain('descriptionHtml');
        expect(marcas).not.toContain('aiTitle');
        expect(marcas).not.toContain('brand');
    });

    it('una descripción en texto que el producto ya tenía (la del canal o una escrita a mano) no se pisa, salvo que se pida volver a redactar', async () => {
        const normal = construir(producto({ aiDescription: 'La real del canal' }));
        await normal.service.preparar(SCOPE, 'p1');
        expect(normal.guardados[0].aiDescription).toBe('La real del canal');

        const rehacer = construir(producto({ aiDescription: 'La real del canal' }));
        await rehacer.service.preparar(SCOPE, 'p1', undefined, { regenerar: true });
        expect(rehacer.guardados[0].aiDescription).toBe('Texto generado para canales sin HTML.');
    });

    it('la IA recibe el texto del cliente y el que ya tenía el producto, sin repetirlos ni los enlaces, y los GIFs van a la plantilla', async () => {
        const { service, ai } = construir(producto({ description: 'Torre de madera https://giphy.com/x.gif', aiDescription: 'Una torre para que el niño aprenda a subir con seguridad.' }));
        await service.preparar(SCOPE, 'p1');
        const datos = ai.generarDescripcionHtml.mock.calls[0][0];
        expect(datos.textoCliente).toContain('Torre de madera');
        expect(datos.textoCliente).toContain('aprenda a subir');
        expect(datos.textoCliente).not.toContain('giphy');
        expect(datos.urlsDelCliente).toEqual(['https://giphy.com/x.gif']);

        const contenido = construir(producto({ description: 'Torre de madera', aiDescription: 'Torre de madera para niños' }));
        await contenido.service.preparar(SCOPE, 'p1');
        expect(contenido.ai.generarDescripcionHtml.mock.calls[0][0].textoCliente).toBe('Torre de madera para niños');
    });
});
