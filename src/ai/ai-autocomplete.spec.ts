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
        const service = new AiService(busqueda, semilla, vision, canales);
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
        expect(canales.requisitos).toHaveBeenCalledWith('mercadolibre', 'MPE1234', 'u1');
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
