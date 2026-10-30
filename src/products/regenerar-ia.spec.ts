import { ProductsService } from './products.service';

/**
 * «Regenerar con IA» sobre un producto que ya existe (por ejemplo, uno importado de un canal): la IA parte de todo lo que el
 * producto tiene y no borra lo que ya tenía; solo rehace la ficha HTML y lo que se ve en las fotos, que es lo que esa acción pide.
 */
function construir(producto: any, contenido: any) {
    const ai: any = { generateProductContent: jest.fn(async () => contenido) };
    const repo: any = { save: jest.fn(async (p: any) => p) };
    const service = new ProductsService(repo, ai, {} as any);
    jest.spyOn(service, 'findOne').mockResolvedValue(producto);
    return { service, ai, repo };
}

const producto = (): any => ({
    id: 'p1', name: 'Proteína Whey Mutant 5 lb', description: 'Sabor vainilla', aiDescription: 'Proteína para recuperación', aiTitle: 'Titulo previo',
    category: null, subCategory: null, targetMarketplaces: ['falabella'],
    images: [{ url: 'https://i/1.jpg' }, { url: 'https://i/2.jpg' }],
    aiAttributes: { brand: 'MUTANT', color: '', _categoriaVerificada: '2804', descriptionHtml: '<div>real del canal</div>', vision: { productType: 'viejo' }, mercadolibre_attributes: { BRAND: 'Mutant' } },
});

const contenido = () => ({
    generatedListings: { falabella: { title: 'Titulo nuevo', description: 'Descripción nueva', brand: 'GENERICO', attributes: { brand: 'GENERICO', color: 'Negro', material: 'Plástico' } } },
    htmlDescription: '<div>nuevo</div>',
    vision: { productType: 'proteína en polvo', color: 'Negro' },
});

describe('regenerar con IA un producto que ya existe', () => {
    it('le manda a la IA el texto que ya tiene, las fotos y la cuenta del dueño', async () => {
        const { service, ai } = construir(producto(), contenido());
        await service.generateAIContent('p1', 'u1', { marketplaces: ['falabella'] });
        expect(ai.generateProductContent).toHaveBeenCalledWith(expect.objectContaining({
            name: 'Proteína Whey Mutant 5 lb',
            description: 'Sabor vainilla\n\nProteína para recuperación',
            imageUrls: ['https://i/1.jpg', 'https://i/2.jpg'],
            userId: 'u1',
        }));
    });

    it('no borra lo que el producto ya tenía: la marca y la categoría verificada se quedan y la IA rellena lo vacío', async () => {
        const { service } = construir(producto(), contenido());
        const r: any = await service.generateAIContent('p1', 'u1');
        expect(r.aiAttributes.brand).toBe('MUTANT');
        expect(r.aiAttributes._categoriaVerificada).toBe('2804');
        expect(r.aiAttributes.color).toBe('Negro');
        expect(r.aiAttributes.material).toBe('Plástico');
        expect(r.aiAttributes.mercadolibre_attributes).toEqual({ BRAND: 'Mutant' });
    });

    it('rehace a propósito la ficha HTML y lo que se ve en las fotos, y anota con qué fotos', async () => {
        const { service } = construir(producto(), contenido());
        const r: any = await service.generateAIContent('p1', 'u1');
        expect(r.aiAttributes.descriptionHtml).toBe('<div>nuevo</div>');
        expect(r.aiAttributes.vision).toEqual({ productType: 'proteína en polvo', color: 'Negro' });
        expect(r.aiAttributes._visionFotos).toEqual(expect.any(String));
        expect(r.aiTitle).toBe('Titulo nuevo');
    });

    it('si la IA no devuelve ficha HTML ni visión, deja las que había', async () => {
        const { service } = construir(producto(), { generatedListings: contenido().generatedListings });
        const r: any = await service.generateAIContent('p1', 'u1');
        expect(r.aiAttributes.descriptionHtml).toBe('<div>real del canal</div>');
        expect(r.aiAttributes.vision).toEqual({ productType: 'viejo' });
    });
});
