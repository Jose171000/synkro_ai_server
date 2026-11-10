import { VariantCompatService } from './variant-compat.service';

const LONCHERAS = [
    { name: 'color_80', description: 'Color — color', isRequired: true, example: '', listCode: 'color_80', isVariant: true },
    { name: 'tipo_product', description: 'Tipo', isRequired: true, example: '' },
];
const SANDALIAS = [
    { name: 'color_80', description: 'Color — color', isRequired: true, example: '', listCode: 'color_80', isVariant: true },
    { name: 'talla_calzado_faceta', description: 'Talla calzado — talla', isRequired: true, example: '', isVariant: true },
];

function construir(opts: { admite?: boolean; candidatas?: any[]; verificaOk?: boolean; guardadas?: any } = {}) {
    const vista = { name: 'Sandalias de cuero', axes: [{ name: 'Color', values: ['Beige', 'Negro'] }, { name: 'Talla', values: ['35', '36'] }] };
    const grupos: any = { obtener: jest.fn(async () => vista) };
    const variantes = [{ id: 'v1', marketplaceIds: opts.guardadas ?? { ripley_category_id: 'R-LONCH', falabella_category_id: 'F1' }, aiAttributes: {}, aiDescription: 'sandalias' }];
    const productos: any = { find: jest.fn(async () => variantes) };
    const sync: any = {
        falabellaCategoryVariants: jest.fn(async () => ({ admiteVariantes: false, camposDeVariacion: [], porTallaYColor: false })),
        ejesDeVariacionMeli: jest.fn(async () => []),
    };
    const ripley: any = {
        campos: jest.fn(async (id: string) => {
            const atributos = id === 'R-SANDALIAS' ? SANDALIAS : LONCHERAS;
            const campos = atributos.map((a) => ({ name: a.name, label: a.description.split(' — ')[0], required: a.isRequired, isVariant: !!(a as any).isVariant, listCode: (a as any).listCode ?? null }));
            const hay = campos.some((c) => c.isVariant);
            return { id, path: id === 'R-SANDALIAS' ? 'CALZADO › SANDALIAS' : 'MALETERÍA › LONCHERAS', campos, ejesDeVariante: [], admiteVariantes: opts.admite ?? (id === 'R-SANDALIAS' && hay) };
        }),
        listaCompleta: jest.fn(async () => ['Beige', 'Negro', 'Marrón']),
    };
    const ai: any = { verificarCategoria: jest.fn(async () => ({ ok: opts.verificaOk ?? true, incierta: false })) };
    const semilla: any = { generateEmbedding: jest.fn(async () => [0.1]) };
    const vectores: any = { findSimilarCategories: jest.fn(async () => opts.candidatas ?? [{ categoryId: 'R-LONCH', name: 'MALETERÍA › LONCHERAS', requiredAttributes: LONCHERAS }, { categoryId: 'R-SANDALIAS', name: 'CALZADO › SANDALIAS', requiredAttributes: SANDALIAS }]) };
    const service = new VariantCompatService(grupos, productos, sync, ripley, ai, semilla, vectores);
    return { service, sync, ripley, ai, vectores };
}
const AMBITO = { userId: 'u', storeId: 's' };

describe('compatibilidad de variantes por canal', () => {
    it('Ripley: la categoría guardada no admite los ejes → separadas, con aviso y una categoría recomendada que sí los admite', async () => {
        const { service, ai } = construir();
        const [r] = await service.revisar('g1', [{ marketplace: 'ripley' }], AMBITO);

        expect(r.publicaComo).toBe('separadas');
        expect(r.avisos[0]).toContain('separados en Ripley');
        expect(r.recomendada).toEqual({ id: 'R-SANDALIAS', ruta: 'CALZADO › SANDALIAS' });
        expect(ai.verificarCategoria).toHaveBeenCalledWith('Sandalias de cuero', 'sandalias', null, 'CALZADO › SANDALIAS');
    });

    it('la recomendación solo se ofrece si la IA verifica que la categoría corresponde al producto', async () => {
        const { service } = construir({ verificaOk: false });
        const [r] = await service.revisar('g1', [{ marketplace: 'ripley' }], AMBITO);
        expect(r.publicaComo).toBe('separadas');
        expect(r.recomendada).toBeNull();
    });

    it('nunca recomienda la misma categoría que ya tiene', async () => {
        const { service } = construir({ guardadas: { ripley_category_id: 'R-LONCH' }, candidatas: [{ categoryId: 'R-LONCH', name: 'MALETERÍA › LONCHERAS', requiredAttributes: SANDALIAS }] });
        const [r] = await service.revisar('g1', [{ marketplace: 'ripley' }], AMBITO);
        expect(r.recomendada).toBeNull();
    });

    it('si la categoría ya admite los ejes: una sola publicación, sin avisos ni recomendación', async () => {
        const { service, vectores } = construir({ guardadas: { ripley_category_id: 'R-SANDALIAS' } });
        const [r] = await service.revisar('g1', [{ marketplace: 'ripley' }], AMBITO);
        expect(r.publicaComo).toBe('una');
        expect(r.avisos).toEqual([]);
        expect(r.recomendada).toBeUndefined();
        expect(vectores.findSimilarCategories).not.toHaveBeenCalled();
    });

    it('una categoría indicada en la consulta vale cuando se pide un solo canal', async () => {
        const { service, ripley } = construir();
        const [r] = await service.revisar('g1', [{ marketplace: 'ripley', categoryId: 'R-SANDALIAS' }], AMBITO);
        expect(ripley.campos).toHaveBeenCalledWith('R-SANDALIAS');
        expect(r.publicaComo).toBe('una');
    });

    it('Falabella: sin variantes en la categoría → separadas, y la recomendación es la que dejó anotada la preparación', async () => {
        const { service } = construir({ guardadas: { falabella_category_id: 'F1' } });
        (service as any).productos.find = jest.fn(async () => [{ id: 'v1', marketplaceIds: { falabella_category_id: 'F1' }, aiAttributes: { _categoriaConVariantes: { falabella: { id: 'F2', path: 'Calzado › Sandalias' } } } }]);
        const [r] = await service.revisar('g1', [{ marketplace: 'falabella' }], AMBITO);
        expect(r.publicaComo).toBe('separadas');
        expect(r.avisos[0]).toContain('separados en Falabella');
        expect(r.recomendada).toEqual({ id: 'F2', ruta: 'Calzado › Sandalias' });
    });

    it('Mercado Libre y Shopify también se revisan, con su propio nombre en el aviso', async () => {
        const { service } = construir({ guardadas: { mercadolibre_category_id: 'MPE1' } });
        const r = await service.revisar('g1', [{ marketplace: 'mercadolibre' }, { marketplace: 'shopify' }], AMBITO);
        expect(r[0].publicaComo).toBe('separadas');
        expect(r[0].avisos[0]).toContain('Mercado Libre');
        expect(r[1]).toMatchObject({ canal: 'shopify', publicaComo: 'una' });
    });

    it('un canal sin categoría guardada no se puede revisar y se omite (no inventa un resultado)', async () => {
        const { service } = construir({ guardadas: {} });
        expect(await service.revisar('g1', [{ marketplace: 'ripley' }, { marketplace: 'falabella' }], AMBITO)).toEqual([]);
    });

    it('si el canal no responde se omite sin romper la revisión de los demás', async () => {
        const { service, sync } = construir({ guardadas: { falabella_category_id: 'F1', ripley_category_id: 'R-SANDALIAS' } });
        sync.falabellaCategoryVariants.mockRejectedValue(new Error('sin cuenta'));
        const r = await service.revisar('g1', [{ marketplace: 'falabella' }, { marketplace: 'ripley' }], AMBITO);
        expect(r.map((x) => x.canal)).toEqual(['ripley']);
    });
});
