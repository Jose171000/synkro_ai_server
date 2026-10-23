import { claveDeFilaMeli, detectarDuplicados } from './meli/duplicados-meli';
import { MeliListingRow } from './meli/meli-listings';
import { planearFamiliasDeMeli } from './meli/familias-meli';

/**
 * Publicaciones repetidas: el mismo SKU publicado más de una vez en la misma cuenta (como ZPT-6 en Lai Home). No son
 * variantes. Solo se enlaza una (la activa con más ventas) y el resto se informa; nunca llegan a la IA ni a la revisión
 * de variantes.
 */
const fila = (externalId: string, sku: string, over: Partial<MeliListingRow> = {}): MeliListingRow => ({
    sku, externalId, variationId: null, title: 'Organizador Zapateras Plegable 6 Niveles', variation: null, regularPrice: 150, salePrice: null,
    stock: 10, status: 'published', permalink: `https://articulo.mercadolibre.com.pe/${externalId}`, imageUrl: `https://img/${externalId}.jpg`,
    images: [], quality: null, currency: 'PEN', vendidas: 0, ...over,
});

describe('detectarDuplicados', () => {
    it('el mismo SKU en tres publicaciones: una principal y dos repetidas', () => {
        const { duplicados, secundarias } = detectarDuplicados([
            fila('MPE1091026438', 'ZPT-6', { vendidas: 0 }),
            fila('MPE1092265970', 'ZPT-6', { vendidas: 3, regularPrice: 80 }),
            fila('MPE1091186540', 'ZPT-6', { vendidas: 0 }),
        ]);
        expect(duplicados).toHaveLength(1);
        expect(duplicados[0].publicaciones.map((p) => [p.externalId, p.principal])).toEqual([
            ['MPE1092265970', true], ['MPE1091026438', false], ['MPE1091186540', false],
        ]);
        expect([...secundarias].sort()).toEqual(['MPE1091026438:', 'MPE1091186540:']);
    });

    it('la principal es la activa aunque otra pausada haya vendido más', () => {
        const { duplicados } = detectarDuplicados([
            fila('A', 'X', { status: 'paused', vendidas: 50 }),
            fila('B', 'X', { status: 'published', vendidas: 1 }),
        ]);
        expect(duplicados[0].publicaciones[0]).toMatchObject({ externalId: 'B', principal: true });
    });

    it('entre activas, gana la que más vendió; con empate, la de más stock', () => {
        const a = detectarDuplicados([fila('A', 'X', { vendidas: 2 }), fila('B', 'X', { vendidas: 9 })]);
        expect(a.duplicados[0].publicaciones[0].externalId).toBe('B');
        const b = detectarDuplicados([fila('A', 'X', { stock: 3 }), fila('B', 'X', { stock: 8 })]);
        expect(b.duplicados[0].publicaciones[0].externalId).toBe('B');
    });

    it('el SKU se compara sin distinguir mayúsculas ni espacios', () => {
        expect(detectarDuplicados([fila('A', 'zpt-6'), fila('B', ' ZPT-6 ')]).duplicados).toHaveLength(1);
    });

    it('SKU distintos o sin SKU no son duplicados', () => {
        expect(detectarDuplicados([fila('A', 'X'), fila('B', 'Y'), fila('C', '')]).duplicados).toEqual([]);
    });

    it('cada variación de una publicación es una fila distinta', () => {
        const { secundarias } = detectarDuplicados([fila('A', 'X', { variationId: '1' }), fila('A', 'X', { variationId: '2' })]);
        expect(secundarias.size).toBe(1);
        expect(claveDeFilaMeli({ externalId: 'A', variationId: '2' })).toBe('A:2');
    });

    it('informa lo que ayuda a decidir: estado, ventas, stock, precio, dirección y si está sincronizada', () => {
        const { duplicados } = detectarDuplicados([fila('A', 'X', { vendidas: 4, sincronizadaCon: 'MPE9', tipo: 'gold_special' }), fila('B', 'X')]);
        expect(duplicados[0].publicaciones[0]).toMatchObject({ estado: 'published', vendidas: 4, stock: 10, precio: 150, sincronizadaCon: 'MPE9', tipo: 'gold_special', permalink: 'https://articulo.mercadolibre.com.pe/A' });
    });
});

describe('las repetidas no se tratan como familia de variantes', () => {
    it('dos publicaciones con el mismo SKU, una vez quitada la repetida, ya no forman una familia', () => {
        const item = (id: string) => ({
            id, title: 'Organizador', status: 'active', price: 150, available_quantity: 10, seller_custom_field: 'ZPT-6', family_id: '8940693542094034', family_name: 'Organizador',
            attributes: [{ id: 'COLOR', name: 'Color', value_name: 'Blanco' }], pictures: [],
        });
        // Con las dos juntas no se podrían distinguir (y irían a la IA); sin la repetida queda una sola.
        expect(planearFamiliasDeMeli([item('MPE1'), item('MPE2')]).sinResolver).toHaveLength(1);
        expect(planearFamiliasDeMeli([item('MPE1')])).toMatchObject({ grupos: [], sinResolver: [] });
    });
});
