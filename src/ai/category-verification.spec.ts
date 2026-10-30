import { AiService } from './ai.service';
import { esCategoriaEquivocada } from '../sync/falabella/falabella-fields';
import { FalabellaAutoPrepService } from './falabella-auto-prep.service';

/** Un AiService sin dependencias reales: solo se prueba la lógica de elegir y verificar categorías. */
function servicio(opts: { elige: (string | null)[]; verifica: boolean[] }): any {
    const ai: any = Object.create(AiService.prototype);
    const eleccion = [...opts.elige];
    const verificacion = [...opts.verifica];
    ai.pedirCategoria = jest.fn(async () => ({ id: eleccion.shift() ?? null, confianza: 0.9, palabras: ['donas', 'mini'] }));
    ai.verificarCategoria = jest.fn(async () => ({ ok: verificacion.shift() ?? false, motivo: 'no corresponde' }));
    return ai;
}

const cat = (categoryId: string, name: string) => ({ categoryId, name } as any);

describe('elegir una categoría y verificarla', () => {
    const candidatas = [cat('1', 'Hogar › Electrodomésticos › Compactadores de basura'), cat('2', 'Hogar › Cocina › Máquinas para hacer donas y wafles')];
    const vision: any = { productType: 'máquina de minidonas', keywords: ['donas', 'cocina'] };

    it('descarta la categoría que la verificación rechaza y prueba otra', async () => {
        const ai = servicio({ elige: ['1', '2'], verifica: [false, true] });
        const r = await ai.elegirCategoriaVerificada('falabella', 'Máquina de minidonas eléctrica', '', candidatas, { vision });
        expect(r.id).toBe('2');
        expect(r.confianza).toBe('alta');
        expect(ai.verificarCategoria).toHaveBeenCalledTimes(2);
    });

    it('si ninguna encaja devuelve «ninguna» en lugar de forzar una categoría equivocada', async () => {
        const ai = servicio({ elige: ['1', null], verifica: [false] });
        const r = await ai.elegirCategoriaVerificada('falabella', 'Máquina de minidonas eléctrica', '', [candidatas[0]], { vision });
        expect(r.id).toBeNull();
        expect(r.confianza).toBe('ninguna');
        expect(r.motivo).toBeTruthy();
    });

    it('amplía la búsqueda con palabras nuevas cuando las candidatas no sirven', async () => {
        const ai = servicio({ elige: [null, '2'], verifica: [true] });
        const buscarMas = jest.fn(async () => [candidatas[1]]);
        const r = await ai.elegirCategoriaVerificada('falabella', 'Máquina de minidonas', '', [candidatas[0]], { vision, buscarMas });
        expect(buscarMas).toHaveBeenCalledTimes(1);
        expect(r.id).toBe('2');
    });

    it('no vuelve a proponer una categoría que ya se descartó', async () => {
        const ai = servicio({ elige: [null], verifica: [] });
        const r = await ai.elegirCategoriaVerificada('falabella', 'Máquina de minidonas', '', [candidatas[0]], { vision, excluir: ['1'] });
        expect(r.id).toBeNull();
        expect(ai.pedirCategoria).not.toHaveBeenCalled();
    });

    it('una categoría verificada pero sin ninguna palabra en común queda con confianza baja', async () => {
        const ai = servicio({ elige: ['9'], verifica: [true] });
        const r = await ai.elegirCategoriaVerificada('falabella', 'Máquina de minidonas', '', [cat('9', 'Deportes › Fitness')], { vision });
        expect(r.id).toBe('9');
        expect(r.confianza).toBe('baja');
        expect(r.motivo).toMatch(/palabras/);
    });

    it('verifica primero la elección previa sin volver a elegir', async () => {
        const ai = servicio({ elige: [], verifica: [true] });
        const r = await ai.elegirCategoriaVerificada('falabella', 'Máquina de minidonas', '', candidatas, { vision, preferida: '2' });
        expect(r.id).toBe('2');
        expect(ai.pedirCategoria).not.toHaveBeenCalled();
    });
});

describe('detectar que Falabella rechazó por una categoría equivocada', () => {
    it('lo reconoce por las reglas propias de la categoría', () => {
        expect(esCategoriaEquivocada('0: El Peso del producto empacado (kg) debe estar entre 9 kg y 27 kg para esta categoría.')).toBe(true);
        expect(esCategoriaEquivocada('Package weight must be between 9 kg and 27 kg for this category')).toBe(true);
    });
    it('no confunde otros rechazos', () => {
        expect(esCategoriaEquivocada('Automatically rejected: Images Missing')).toBe(false);
        expect(esCategoriaEquivocada('0: Esta marca no existe en nuestra base de datos')).toBe(false);
        expect(esCategoriaEquivocada(null)).toBe(false);
    });
});

describe('preparar un producto sin categoría segura', () => {
    function construir(elegida: any, producto: any) {
        const sync: any = {
            findScopedProduct: jest.fn(async () => producto),
            familiaDe: jest.fn(async () => [producto]),
            falabellaCategoryVariants: jest.fn(async () => ({ admiteVariantes: false })),
            resolveConnection: jest.fn(async () => ({ id: 'c1' })),
            credentialsOf: jest.fn(() => ({ userId: 'x', apiKey: 'k' })),
            categoriaFalabella: jest.fn((p: any) => p.marketplaceIds?.falabella_category_id),
            buscarAtributo: jest.fn((a: any, n: string) => a[n]),
            nombreParaFalabella: jest.fn((n: string) => n),
            toFalabellaInput: jest.fn((p: any) => (p.marketplaceIds?.falabella_category_id ? { input: {} } : { reason: 'no tiene categoría de Falabella asignada' })),
        };
        const falabella: any = {
            brandsIndex: jest.fn(async () => new Map()),
            getCategoryAttributes: jest.fn(async () => []),
            getCategories: jest.fn(async () => [{ id: '77', path: 'Hogar › Compactadores de basura' }]),
        };
        const ai: any = {
            elegirCategoriaVerificada: jest.fn(async () => elegida),
            verificarCategoria: jest.fn(async () => ({ ok: false, motivo: 'no corresponde' })),
            estimarPaquete: jest.fn(async () => ({ width: 20, length: 20, height: 20, weight: 1 })),
            generarDescripcionHtml: jest.fn(async () => null),
            completarAtributos: jest.fn(async () => ({ values: {}, estimated: [] })),
        };
        const canales: any = { candidatasFalabella: jest.fn(async () => []), requisitos: jest.fn(async () => []) };
        const guardados: any[] = [];
        const products: any = { save: jest.fn(async (p: any) => { guardados.push(JSON.parse(JSON.stringify(p))); return p; }) };
        const vectores: any = { findSimilarCategories: jest.fn(async () => []) };
        const seeder: any = { generateEmbedding: jest.fn(async () => [0.1]) };
        const vision: any = { analyze: jest.fn(async () => null) };
        return { service: new FalabellaAutoPrepService(sync, falabella, ai, canales, vectores, seeder, products, vision), guardados, ai };
    }
    const producto = (extra: any = {}) => ({
        id: 'p1', sku: 'CO126', name: 'Máquina de minidonas eléctrica', aiTitle: null, description: 'Hace donas', aiDescription: null,
        packageWidth: 20, packageLength: 20, packageHeight: 20, packageWeight: 1,
        marketplaceIds: {}, aiAttributes: { brand: 'GENERICO' }, ...extra,
    });

    it('si ninguna categoría encaja, no publica y explica por qué', async () => {
        const { service, guardados } = construir({ id: null, confianza: 'ninguna', motivo: 'ninguna candidata encaja' }, producto());
        const r = await service.preparar({ userId: 'u', storeId: 's' }, 'p1');
        expect(r.listo).toBe(false);
        expect(r.category).toBeNull();
        expect(r.motivo).toMatch(/categoría de Falabella que encaje/);
        expect(guardados[0].aiAttributes._categoriaDudosa).toMatchObject({ id: null });
    });

    it('una categoría previa que la verificación rechaza se descarta y se elige otra', async () => {
        const p = producto({ marketplaceIds: { falabella_category_id: '77' } });
        const { service, ai, guardados } = construir({ id: '2804', confianza: 'alta', ruta: 'Hogar › Cocina' }, p);
        const r = await service.preparar({ userId: 'u', storeId: 's' }, 'p1');
        expect(ai.verificarCategoria).toHaveBeenCalledTimes(1);
        expect(ai.elegirCategoriaVerificada.mock.calls[0][4].excluir).toEqual(['77']);
        expect(r.category?.id).toBe('2804');
        expect(guardados[0].marketplaceIds.falabella_category_id).toBe('2804');
    });

    it('una categoría elegida por una persona no se vuelve a juzgar', async () => {
        const p = producto({ marketplaceIds: { falabella_category_id: '77' }, aiAttributes: { brand: 'GENERICO', _categoriaManual: '77' } });
        const { service, ai } = construir({ id: '1', confianza: 'alta' }, p);
        const r = await service.preparar({ userId: 'u', storeId: 's' }, 'p1');
        expect(ai.verificarCategoria).not.toHaveBeenCalled();
        expect(ai.elegirCategoriaVerificada).not.toHaveBeenCalled();
        expect(r.category).toMatchObject({ id: '77', confidence: 'manual' });
    });
});
