process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test';
import { AiService } from './ai.service';
import { normalizarVision } from './product-vision.service';
import { atributosDeMeli } from './channel-attributes.service';

describe('lo que la IA ve en las fotos', () => {
    it('descarta respuestas sin producto y limpia los textos', () => {
        expect(normalizarVision(null)).toBeNull();
        expect(normalizarVision({ color: 'rojo' })).toBeNull();
        const v = normalizarVision({
            productType: ' sábanas ', suggestedName: 'Juego de sábanas turquesa', description: '', brand: '  ', color: 'Turquesa',
            keywords: ['sábanas', '', 5], attributes: { Piezas: '4', vacio: '' }, confidence: 7,
        })!;
        expect(v).toMatchObject({ productType: 'sábanas', brand: null, color: 'Turquesa', confidence: 1 });
        expect(v.keywords).toEqual(['sábanas']);
        expect(v.attributes).toEqual({ Piezas: '4' });
    });
});

describe('atributos que pide Mercado Libre', () => {
    const crudos = [
        { id: 'BRAND', name: 'Marca', tags: { required: true } },
        { id: 'COLOR', name: 'Color', tags: { required: true }, values: [{ name: 'Azul' }, { name: 'Rojo' }] },
        { id: 'GTIN', name: 'Código', tags: { hidden: true, required: true } },
        { id: 'MATERIAL', name: 'Material', hint: 'Del tejido', tags: {} },
        { id: 'LOTE', name: 'Lote', tags: { read_only: true } },
    ];

    it('deja los obligatorios primero, con sus valores permitidos, y quita ocultos, fijos y los que ya se envían', () => {
        const r = atributosDeMeli(crudos);
        expect(r.map((a) => a.name)).toEqual(['COLOR', 'MATERIAL']);
        expect(r[0]).toMatchObject({ isRequired: true, options: ['Azul', 'Rojo'] });
        expect(r[1]).toMatchObject({ isRequired: false, description: 'Material — Del tejido' });
    });
});

describe('autocompletar un producto desde sus fotos', () => {
    function construir() {
        const vision: any = {
            analyze: jest.fn(async () => ({
                productType: 'juego de sábanas', suggestedName: 'Juego de sábanas turquesa queen', description: 'Sábanas lisas turquesa.',
                brand: null, color: 'Turquesa', material: 'Microfibra', gender: null, keywords: ['sábanas', 'cama'], attributes: {}, confidence: 0.9,
            })),
        };
        const canales: any = {
            predecirCategoriaMeli: jest.fn(async () => 'MPE1234'),
            requisitos: jest.fn(async () => [
                { name: 'COLOR', description: 'Color', example: 'Azul', isRequired: true, options: ['Azul', 'Turquesa'] },
                { name: 'MATERIAL', description: 'Material', example: '', isRequired: true },
            ]),
        };
        const busqueda: any = { findSimilarCategories: jest.fn(async () => []) };
        const semilla: any = { generateEmbedding: jest.fn(async () => [0.1, 0.2]) };
        const service = new AiService(busqueda, semilla, vision, canales, { asegurarImportadas: jest.fn() } as any);
        const create = jest.fn(async (req: any) => {
            const pedido = req.messages[1].content as string;
            // La segunda llamada (generación) es la que lleva las reglas de los marketplaces.
            if (pedido.includes('REGLAS ESTRICTAS')) {
                return { choices: [{ message: { content: JSON.stringify({ mercadolibre: { title: 'Juego de sábanas', condition: 'new', description: 'x', attributes: { COLOR: 'Turquesa', MATERIAL: null } } }) } }] };
            }
            return { choices: [{ message: { content: JSON.stringify({ mercadolibre_category_id: 'MPE-DEL-VECTOR' }) } }] };
        });
        (service as any).openai = { chat: { completions: { create } } };
        return { service, vision, canales, create };
    }

    it('usa la categoría real de Mercado Libre, pide sus atributos y reporta solo lo que no pudo deducir', async () => {
        const { service, vision, canales, create } = construir();
        const r = await service.generateProductContent({
            name: 'sábanas', description: 'sábanas', targetMarketplaces: ['mercadolibre'], imageUrls: ['https://x/1.jpg'], userId: 'u1',
        });

        expect(vision.analyze).toHaveBeenCalledWith(['https://x/1.jpg'], expect.anything());
        expect(r.categorizedAs.mercadolibre_category_id).toBe('MPE1234');
        expect(canales.requisitos).toHaveBeenCalledWith('mercadolibre', 'MPE1234', 'u1', { titulo: 'Juego de sábanas turquesa queen', palabras: ['juego de sábanas', 'sábanas', 'cama'] });
        // El nombre corto del cliente se completa con lo que se ve en la foto.
        const prompt = create.mock.calls[1][0].messages[1].content as string;
        expect(prompt).toContain('Juego de sábanas turquesa queen');
        expect(prompt).toContain('ELIGE EXACTAMENTE UNO DE: Azul | Turquesa');
        expect(prompt).toContain('NUNCA inventes');
        expect(r.missingAttributes).toEqual({ mercadolibre: [{ name: 'MATERIAL', description: 'Material' }] });
    });

    it('sin fotos sigue funcionando como antes', async () => {
        const { service, vision } = construir();
        const r = await service.generateProductContent({ name: 'sábanas', description: 'sábanas', targetMarketplaces: ['mercadolibre'] });
        expect(vision.analyze).not.toHaveBeenCalled();
        expect(r.vision).toBeNull();
    });
});

describe('medidas del paquete y modo masivo', () => {
    const { normalizarPaquete } = require('./ai.service');

    it('las medidas de la IA se vuelven números seguros y lo inservible se descarta', () => {
        expect(normalizarPaquete({ packageWidth: 30.4, packageLength: 40, packageHeight: 5, packageWeight: 1.23456, fromClient: true }))
            .toEqual({ width: 30, length: 40, height: 5, weight: 1.235, fromClient: true });
        expect(normalizarPaquete({ packageWidth: 0, packageLength: 40, packageHeight: 5, packageWeight: 1 })).toBeNull();
        expect(normalizarPaquete({ packageWidth: 9999, packageLength: 40, packageHeight: 5, packageWeight: 999 }))
            .toMatchObject({ width: 200, weight: 70, fromClient: false });
        expect(normalizarPaquete(null)).toBeNull();
    });

    function construir() {
        const canales: any = {
            predecirCategoriaMeli: jest.fn(async () => null),
            credencialesDe: jest.fn(async () => null),
            requisitos: jest.fn(async () => [{ name: 'tipo_tela', description: 'Tipo de tela', example: 'Algodón', isRequired: true, options: ['Algodón', 'Poliéster'] }]),
        };
        const busqueda: any = { findSimilarCategories: jest.fn(async () => [{ categoryId: '1234', name: 'Sábanas', requiredAttributes: [] }]) };
        const semilla: any = { generateEmbedding: jest.fn(async () => [0.1]) };
        const vision: any = { analyze: jest.fn(async () => null) };
        const service = new AiService(busqueda, semilla, vision, canales, { asegurarImportadas: jest.fn() } as any);
        const prompts: string[] = [];
        const create = jest.fn(async (req: any) => {
            const p = req.messages[req.messages.length - 1].content as string;
            prompts.push(p);
            if (p.includes('logística')) return { choices: [{ message: { content: JSON.stringify({ packageWidth: 30, packageLength: 40, packageHeight: 10, packageWeight: 2, fromClient: false }) } }] };
            if (p.includes('REGLAS ESTRICTAS')) return { choices: [{ message: { content: JSON.stringify({ falabella: { name: 'Sábanas', description: 'x', brand: 'GENERICO', attributes: { tipo_tela: 'Algodón', _estimated: ['tipo_tela'] } } }) } }] };
            return { choices: [{ message: { content: JSON.stringify({ falabella_category_id: '1234' }) } }] };
        });
        (service as any).openai = { chat: { completions: { create } } };
        return { service, prompts };
    }

    it('en modo masivo pide estimar lo que falte, anota qué se estimó y estima el paquete para Falabella', async () => {
        const { service, prompts } = construir();
        const r = await service.generateProductContent({ name: 'Sábanas bamboo queen', description: 'sábanas', targetMarketplaces: ['falabella'], userId: 'u', estimar: true });

        expect(prompts.find((p) => p.includes('REGLAS ESTRICTAS'))).toContain('ESTIMA el valor más probable');
        expect(r.estimatedAttributes).toEqual({ falabella: ['tipo_tela'] });
        expect((r.generatedListings as any).falabella.attributes).toEqual({ tipo_tela: 'Algodón' });
        expect(r.packageEstimate).toEqual({ width: 30, length: 40, height: 10, weight: 2, fromClient: false });
    });

    it('en modo normal no estima atributos y sin Falabella no calcula el paquete', async () => {
        const { service, prompts } = construir();
        const r = await service.generateProductContent({ name: 'Sábanas bamboo queen', description: 'sábanas', targetMarketplaces: ['mercadolibre'] });
        expect(prompts.some((p) => p.includes('ESTIMA el valor más probable'))).toBe(false);
        expect(r.packageEstimate).toBeNull();
    });
});

describe('JSON de la IA mal formado', () => {
    const servicio = () => new AiService({} as any, {} as any, {} as any, {} as any, { asegurarImportadas: jest.fn() } as any);
    const respuesta = (contenido: string) => ({ choices: [{ message: { content: contenido } }] });

    it('lo vuelve a pedir y usa la primera respuesta válida', async () => {
        const pedir = jest.fn()
            .mockResolvedValueOnce(respuesta('{"title": "Ropero "negro" de tela"}'))
            .mockResolvedValueOnce(respuesta('{"title": "Ropero negro de tela"}'));
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        await expect(servicio().jsonDeLaIa(pedir)).resolves.toEqual({ title: 'Ropero negro de tela' });
        expect(pedir).toHaveBeenCalledTimes(2);
    });

    it('si todos los intentos vienen mal, falla con el error de lectura', async () => {
        const pedir = jest.fn(async () => respuesta('{"title": "mal"'));
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        await expect(servicio().jsonDeLaIa(pedir, 2)).rejects.toThrow(SyntaxError);
        expect(pedir).toHaveBeenCalledTimes(2);
    });
});
