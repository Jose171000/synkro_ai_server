process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test';
import { AiService } from './ai.service';

/** Regenerar con IA no reabre la categoría que un producto ya tiene en un canal. */
describe('la categoría ya elegida no se cambia al generar con IA', () => {
    function construir(opts: { categoriaDeLaIa?: string } = {}) {
        const vision: any = { analyze: jest.fn(async () => null) };
        const canales: any = {
            predecirCategoriaMeli: jest.fn(async () => 'MPE-OTRA'),
            credencialesDe: jest.fn(async () => null),
            requisitos: jest.fn(async () => [{ name: 'COLOR', description: 'Color', example: 'Azul', isRequired: true }]),
        };
        const busqueda: any = { findSimilarCategories: jest.fn(async () => [{ categoryId: opts.categoriaDeLaIa ?? 'MPE-DE-LA-IA', name: 'Otra categoría', requiredAttributes: [] }]) };
        const semilla: any = { generateEmbedding: jest.fn(async () => [0.1]) };
        const service = new AiService(busqueda, semilla, vision, canales, { asegurarImportadas: jest.fn() } as any);
        const create = jest.fn(async (req: any) => {
            const pedido = req.messages[1].content as string;
            if (pedido.includes('REGLAS ESTRICTAS')) {
                return { choices: [{ message: { content: JSON.stringify({ mercadolibre: { title: 'Sábanas', condition: 'new', description: 'x', attributes: { COLOR: 'Azul' } } }) } }] };
            }
            return { choices: [{ message: { content: JSON.stringify({ mercadolibre_category_id: opts.categoriaDeLaIa ?? 'MPE-DE-LA-IA' }) } }] };
        });
        (service as any).openai = { chat: { completions: { create } } };
        return { service, canales, busqueda, create };
    }

    it('con la categoría ya elegida no busca ni clasifica otra, y pide los atributos de la elegida', async () => {
        const { service, canales, busqueda, create } = construir();
        const r = await service.generateProductContent({
            name: 'sábanas', description: 'sábanas', targetMarketplaces: ['mercadolibre'], userId: 'u1',
            categoriasElegidas: { mercadolibre: 'MPE-ELEGIDA' },
        });

        expect(r.categorizedAs.mercadolibre_category_id).toBe('MPE-ELEGIDA');
        expect(r.categoryChecks.mercadolibre).toMatchObject({ id: 'MPE-ELEGIDA', confianza: 'elegida' });
        expect(canales.predecirCategoriaMeli).not.toHaveBeenCalled();
        expect(busqueda.findSimilarCategories).not.toHaveBeenCalled();
        expect(canales.requisitos).toHaveBeenCalledWith('mercadolibre', 'MPE-ELEGIDA', 'u1', expect.anything());
        // Solo se hizo la llamada de generación (con las reglas de los canales) y la del paquete, no la de clasificación.
        expect(create).toHaveBeenCalledTimes(2);
        expect((create.mock.calls[0][0].messages[1].content as string)).toContain('REGLAS ESTRICTAS');
    });

    it('sin categoría elegida sigue clasificando como siempre', async () => {
        const { service, canales, busqueda, create } = construir();
        const r = await service.generateProductContent({ name: 'sábanas', description: 'sábanas', targetMarketplaces: ['mercadolibre'], userId: 'u1' });

        expect(busqueda.findSimilarCategories).toHaveBeenCalled();
        expect(canales.predecirCategoriaMeli).toHaveBeenCalled();
        expect(r.categorizedAs.mercadolibre_category_id).toBe('MPE-OTRA');
        expect(create).toHaveBeenCalledTimes(3);
    });

    it('es por canal: con la categoría de Mercado Libre elegida y la de otro canal sin elegir, solo se busca la que falta', async () => {
        const { service, busqueda } = construir();
        await service.generateProductContent({
            name: 'sábanas', description: 'sábanas', targetMarketplaces: ['mercadolibre', 'amazon'], userId: 'u1',
            categoriasElegidas: { mercadolibre: 'MPE-ELEGIDA' },
        });
        const canalesBuscados = busqueda.findSimilarCategories.mock.calls.map((c: any[]) => c[1]);
        expect(canalesBuscados).toEqual(['amazon']);
    });
});
