import { planearFamiliasDeMeli } from './meli/familias-meli';

/**
 * Familias de Mercado Libre: publicaciones separadas que comparten family_id. Con datos como los de Lai Home (sábanas
 * Casatex Queen: cada publicación cambia de COLOR y comparte tamaño) se agrupan con su eje; lo dudoso no se agrupa.
 */
const atributos = (o: Record<string, string>) => Object.entries(o).map(([id, value_name]) => ({ id, name: nombreDe(id), value_name }));
const nombreDe = (id: string) => ({ COLOR: 'Color', MAIN_COLOR: 'Color principal', MATTRESS_SIZE: 'Tamaño del colchón', SIZE: 'Talla' } as Record<string, string>)[id] ?? id;

const publicacion = (id: string, sku: string, attrs: Record<string, string>, over: any = {}) => ({
    id, title: `Sábana Estampada 2000 Hilos Casatex - Queen ${attrs.COLOR ?? ''}`, status: 'active', price: 180, available_quantity: 4,
    seller_custom_field: sku, family_id: '2189118099048784', family_name: 'Sábana Estampada 2000 Hilos Casatex - Queen', category_id: 'MPE1',
    pictures: [{ id: `f-${id}`, secure_url: `https://img/${id}.jpg` }],
    attributes: atributos({ BRAND: 'CASATEX', MATTRESS_SIZE: 'Queen', ITEM_CONDITION: 'Nuevo', ...attrs }),
    ...over,
});

describe('planearFamiliasDeMeli', () => {
    const casatex = () => [
        publicacion('MPE1', 'P13-180-Q-BGBC__31166982', { COLOR: 'Beige, gris claro y blanco', MAIN_COLOR: 'Beige' }),
        publicacion('MPE2', 'P13-180-Q-CTCM__31166975', { COLOR: 'Crema, terracota, celeste y marrón', MAIN_COLOR: 'Multicolor' }),
        publicacion('MPE3', 'P13-180-Q-VABS__31166977', { COLOR: 'Verde agua, blanco y beige suave', MAIN_COLOR: 'Multicolor' }),
    ];

    it('la familia es un producto con variantes; el eje es el COLOR y cada una conserva su SKU limpio', () => {
        const { grupos, sinResolver } = planearFamiliasDeMeli(casatex());
        expect(sinResolver).toEqual([]);
        expect(grupos).toHaveLength(1);
        expect(grupos[0]).toMatchObject({ parentSku: 'FAM-2189118099048784', name: 'Sábana Estampada 2000 Hilos Casatex - Queen' });
        // MAIN_COLOR describe lo mismo con menos detalle: no es un segundo eje. El tamaño es igual en todas: tampoco.
        expect(grupos[0].axes).toEqual([{ name: 'Color', values: ['Beige, gris claro y blanco', 'Crema, terracota, celeste y marrón', 'Verde agua, blanco y beige suave'] }]);
        expect(grupos[0].variants.map((v) => v.sellerSku)).toEqual(['P13-180-Q-BGBC', 'P13-180-Q-CTCM', 'P13-180-Q-VABS']);
        expect(grupos[0].variants[1].values).toEqual({ Color: 'Crema, terracota, celeste y marrón' });
    });

    it('si Mercado Libre dice qué atributos admiten variación, solo esos pueden ser ejes', () => {
        const items = [
            publicacion('MPE1', 'A', { COLOR: 'Rojo', MATTRESS_SIZE: 'Queen', LINE: 'Premium' }),
            publicacion('MPE2', 'B', { COLOR: 'Azul', MATTRESS_SIZE: 'King', LINE: 'Básica' }),
        ];
        const solo = planearFamiliasDeMeli(items, new Map([['MPE1', new Set(['COLOR'])]]));
        expect(solo.grupos[0].axes.map((e) => e.name)).toEqual(['Color']);
        const dos = planearFamiliasDeMeli(items, new Map([['MPE1', new Set(['COLOR', 'MATTRESS_SIZE'])]]));
        expect(dos.grupos[0].axes.map((e) => e.name)).toEqual(['Color', 'Tamaño del colchón']);
    });

    it('los códigos y datos técnicos que cambian (GTIN, estado) no son ejes', () => {
        const items = [
            publicacion('MPE1', 'A', { COLOR: 'Rojo', GTIN: '111', ITEM_CONDITION: 'Nuevo' }),
            publicacion('MPE2', 'B', { COLOR: 'Azul', GTIN: '222', ITEM_CONDITION: 'Usado' }),
        ];
        expect(planearFamiliasDeMeli(items).grupos[0].axes.map((e) => e.name)).toEqual(['Color']);
    });

    it('una familia de una sola publicación, o publicaciones sin familia, no forman grupo', () => {
        expect(planearFamiliasDeMeli([publicacion('MPE1', 'A', { COLOR: 'Rojo' })]).grupos).toEqual([]);
        expect(planearFamiliasDeMeli([publicacion('MPE1', 'A', { COLOR: 'Rojo' }, { family_id: undefined }), publicacion('MPE2', 'B', { COLOR: 'Azul' }, { family_id: undefined })]).grupos).toEqual([]);
    });

    it('las publicaciones sin SKU no cuentan: con menos de dos con SKU no hay grupo', () => {
        const items = [publicacion('MPE1', 'A', { COLOR: 'Rojo' }), publicacion('MPE2', '', { COLOR: 'Azul' }, { seller_custom_field: undefined })];
        expect(planearFamiliasDeMeli(items).grupos).toEqual([]);
    });

    it('las publicaciones con variaciones propias no se tratan como familia', () => {
        const items = [publicacion('MPE1', 'A', { COLOR: 'Rojo' }, { variations: [{ id: 1 }] }), publicacion('MPE2', 'B', { COLOR: 'Azul' })];
        expect(planearFamiliasDeMeli(items).grupos).toEqual([]);
    });

    it('si nada las distingue no se agrupa: queda para la IA y la revisión manual, con sus fotos', () => {
        const items = [publicacion('MPE1', 'A', { COLOR: 'Rojo' }), publicacion('MPE2', 'B', { COLOR: 'Rojo' })];
        const r = planearFamiliasDeMeli(items);
        expect(r.grupos).toEqual([]);
        expect(r.sinResolver[0]).toMatchObject({ parentSku: 'FAM-2189118099048784', skus: ['A', 'B'] });
        expect(r.sinResolver[0].fichas?.map((f) => [f.sku, f.imagen])).toEqual([['A', 'https://img/MPE1.jpg'], ['B', 'https://img/MPE2.jpg']]);
        // Y a la IA le llegan las publicaciones con sus atributos como evidencia.
        expect(r.paraLaIA.map((p) => p.SellerSku)).toEqual(['A', 'B']);
        expect(r.paraLaIA[0].ProductData).toMatchObject({ COLOR: 'Rojo', MATTRESS_SIZE: 'Queen' });
    });

    it('combinaciones repetidas no se agrupan', () => {
        const items = [
            publicacion('MPE1', 'A', { COLOR: 'Rojo', SIZE: 'S' }), publicacion('MPE2', 'B', { COLOR: 'Rojo', SIZE: 'S' }), publicacion('MPE3', 'C', { COLOR: 'Azul', SIZE: 'S' }),
        ];
        const r = planearFamiliasDeMeli(items);
        expect(r.grupos).toEqual([]);
        expect(r.sinResolver).toHaveLength(1);
    });
});
