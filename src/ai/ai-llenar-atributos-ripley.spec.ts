process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test';
import { AiService } from './ai.service';

/** «Llenar atributos» de Ripley: con la categoría ya elegida, solo completa lo vacío. */
describe('llenar atributos de Ripley', () => {
    const requisitos = [
        { name: 'color_80', description: 'Color', example: '', isRequired: true, listCode: 'color_80', isVariant: true },
        { name: 'tipo_product', description: 'Tipo de producto', example: '', isRequired: true, listCode: 'tipo_product' },
        { name: 'escolar', description: 'Escolar', example: '', isRequired: true, listCode: 'escolar' },
        { name: 'material_v2', description: 'Material', example: '', isRequired: false },
        { name: 'modelo', description: 'Modelo', example: '', isRequired: false },
    ];
    const listas = new Map<string, string[]>([['color_80', ['Beige', 'Marrón', 'Negro']], ['tipo_product', ['Loncheras', 'Maletas']], ['escolar', ['Sí', 'No']]]);

    function construir(respuestaDeLaIa: Record<string, any>) {
        const canales: any = {
            requisitos: jest.fn(async () => requisitos),
            listasDeRipley: jest.fn(async () => listas),
        };
        const vision: any = { analyze: jest.fn(async () => ({ productType: 'lonchera', keywords: ['lonchera'], color: 'marrón' })) };
        const busqueda: any = { findSimilarCategories: jest.fn(async () => []) };
        const semilla: any = { generateEmbedding: jest.fn(async () => [0.1]) };
        const service = new AiService(busqueda, semilla, vision, canales, { asegurarImportadas: jest.fn() } as any);
        const create = jest.fn(async () => ({ choices: [{ message: { content: JSON.stringify(respuestaDeLaIa) } }] }));
        (service as any).openai = { chat: { completions: { create } } };
        return { service, canales, vision, busqueda, semilla, create };
    }

    it('solo pide y devuelve los atributos vacíos: lo que ya tiene valor no se toca', async () => {
        const { service, create } = construir({ tipo_product: 'lonchera', escolar: 'no', material_v2: 'Poliéster', modelo: 'OTRO MODELO', color_80: 'Negro' });
        const r = await service.rellenarAtributosDeRipley({
            nombre: 'LONCHERA', descripcion: 'x', categoryId: 'R141100000000', userId: 'u1',
            actuales: { color_80: 'Marrón', modelo: 'LONCHERA PUFFER' }, visionGuardada: { productType: 'lonchera' },
        });

        // Los ya escritos (color, modelo) no se pidieron ni se devuelven, aunque la IA "opine" otra cosa.
        const pedido = (create.mock.calls[0] as any[])[0].messages[1].content as string;
        expect(pedido).not.toContain('"color_80"');
        expect(pedido).not.toContain('"modelo"');
        expect(pedido).toContain('"tipo_product"');
        expect(Object.keys(r.values).sort()).toEqual(['escolar', 'material_v2', 'tipo_product']);
        expect(r.values).toMatchObject({ tipo_product: 'Loncheras', escolar: 'No', material_v2: 'Poliéster' });
        expect(r.filled).toBe(3);
    });

    it('no elige ni busca categoría: usa la que le dan', async () => {
        const { service, canales, busqueda, semilla } = construir({ tipo_product: 'Loncheras' });
        await service.rellenarAtributosDeRipley({ nombre: 'LONCHERA', descripcion: 'x', categoryId: 'R141100000000', userId: 'u1', actuales: {}, visionGuardada: {} });

        expect(canales.requisitos).toHaveBeenCalledWith('ripley', 'R141100000000', 'u1', undefined, undefined, { todos: true });
        expect(busqueda.findSimilarCategories).not.toHaveBeenCalled();
        expect(semilla.generateEmbedding).not.toHaveBeenCalled();
    });

    it('un valor sin equivalente en la lista de Ripley no se devuelve y se informa', async () => {
        const { service } = construir({ tipo_product: 'Loncheras', escolar: 'quizás' });
        const r = await service.rellenarAtributosDeRipley({ nombre: 'L', descripcion: 'x', categoryId: 'R1', actuales: {}, visionGuardada: {} });
        expect(r.values.escolar).toBeUndefined();
        // Queda sin valor para que lo complete una persona (en vez de mandar algo que Ripley rechazaría).
        expect(r.sinValor).toContain('escolar');
        expect(r.sinValor).not.toContain('tipo_product');
    });

    it('en un grupo de variantes no rellena el color (se toma de cada variante) y entiende los ejes', async () => {
        const { service, create } = construir({ tipo_product: 'Loncheras', color_80: 'Negro' });
        const r = await service.rellenarAtributosDeRipley({
            nombre: 'LONCHERA', descripcion: 'x', categoryId: 'R1', actuales: {}, visionGuardada: {},
            ejes: [{ name: 'Color', values: ['Marrón', 'Negro'] }],
        });
        const pedido = (create.mock.calls[0] as any[])[0].messages[1].content as string;
        expect(pedido).not.toContain('"color_80"');
        expect(pedido).toContain('Color: Marrón, Negro');
        expect(r.values.color_80).toBeUndefined();
    });

    it('si no queda nada vacío no llama a la IA', async () => {
        const { service, create } = construir({});
        const r = await service.rellenarAtributosDeRipley({
            nombre: 'L', descripcion: 'x', categoryId: 'R1', visionGuardada: {},
            actuales: { color_80: 'Marrón', tipo_product: 'Loncheras', escolar: 'No', material_v2: 'Poliéster', modelo: 'M' },
        });
        expect(create).not.toHaveBeenCalled();
        expect(r).toMatchObject({ values: {}, filled: 0 });
    });

    it('sin fotos analizadas y con fotos, las analiza una vez; con la visión ya guardada no vuelve a analizar', async () => {
        const a = construir({ tipo_product: 'Loncheras' });
        await a.service.rellenarAtributosDeRipley({ nombre: 'L', descripcion: 'x', categoryId: 'R1', actuales: {}, fotos: ['https://x/1.jpg'] });
        expect(a.vision.analyze).toHaveBeenCalledTimes(1);
        const b = construir({ tipo_product: 'Loncheras' });
        await b.service.rellenarAtributosDeRipley({ nombre: 'L', descripcion: 'x', categoryId: 'R1', actuales: {}, fotos: ['https://x/1.jpg'], visionGuardada: { productType: 'x' } });
        expect(b.vision.analyze).not.toHaveBeenCalled();
    });
});
