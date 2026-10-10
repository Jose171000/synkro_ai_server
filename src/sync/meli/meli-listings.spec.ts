import { estadoDeItemMeli, filasDeItemMeli } from './meli-listings';

/**
 * Las publicaciones de Mercado Libre se leen «una fila por SKU». Lo que se
 * protege: el SKU se encuentra donde sea que lo haya puesto el vendedor, cada
 * variante es su propia fila con su stock, y una publicación bloqueada no se
 * muestra como viva.
 */
const simple = {
    id: 'MPE111', title: 'Reloj deportivo', status: 'active', price: 90, original_price: null, currency_id: 'PEN',
    available_quantity: 7, permalink: 'https://articulo.mercadolibre.com.pe/MPE-111', health: 0.83,
    seller_custom_field: 'REL-01',
    pictures: [{ id: 'p1', secure_url: 'https://img/1.jpg' }, { id: 'p2', secure_url: 'https://img/2.jpg' }],
};

describe('publicación sin variantes', () => {
    it('da una fila con el SKU, el precio, el stock y la foto', () => {
        const { rows, sinSku } = filasDeItemMeli(simple);
        expect(sinSku).toBe(0);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            sku: 'REL-01', externalId: 'MPE111', variationId: null, regularPrice: 90, salePrice: null, stock: 7,
            status: 'published', imageUrl: 'https://img/1.jpg', currency: 'PEN', quality: 83,
        });
        expect(rows[0].images).toEqual(['https://img/1.jpg', 'https://img/2.jpg']);
    });

    it('encuentra el SKU en el atributo SELLER_SKU si el campo antiguo está vacío', () => {
        const { rows } = filasDeItemMeli({ ...simple, seller_custom_field: null, attributes: [{ id: 'SELLER_SKU', value_name: ' ATR-9 ' }] });
        expect(rows[0].sku).toBe('ATR-9');
    });

    it('una publicación sin SKU no se puede enlazar: se cuenta aparte', () => {
        const r = filasDeItemMeli({ ...simple, seller_custom_field: null, attributes: [] });
        expect(r.rows).toEqual([]);
        expect(r.sinSku).toBe(1);
    });

    it('con promoción, el precio de lista es el regular y el que se cobra es el descuento', () => {
        const { rows } = filasDeItemMeli({ ...simple, price: 70, original_price: 100 });
        expect(rows[0]).toMatchObject({ regularPrice: 100, salePrice: 70 });
    });

    it('un precio de lista menor o igual no es una promoción', () => {
        expect(filasDeItemMeli({ ...simple, price: 90, original_price: 90 }).rows[0].salePrice).toBeNull();
        expect(filasDeItemMeli({ ...simple, price: 90, original_price: 50 }).rows[0].salePrice).toBeNull();
    });

    it('sin fotos usa la miniatura, y sin salud la nota queda vacía', () => {
        const { rows } = filasDeItemMeli({ ...simple, pictures: [], thumbnail: 'https://img/mini.jpg', health: undefined });
        expect(rows[0].imageUrl).toBe('https://img/mini.jpg');
        expect(rows[0].quality).toBeNull();
    });

    it('una respuesta sin id no da filas ni rompe', () => {
        expect(filasDeItemMeli({})).toEqual({ rows: [], sinSku: 0 });
        expect(filasDeItemMeli(null)).toEqual({ rows: [], sinSku: 0 });
    });
});

describe('publicación con variantes', () => {
    const conVariantes = {
        ...simple, seller_custom_field: null, available_quantity: 12,
        variations: [
            { id: 501, price: 90, available_quantity: 5, seller_custom_field: 'REL-01-NEG', picture_ids: ['p2'], attribute_combinations: [{ name: 'Color', value_name: 'Negro' }] },
            { id: 502, price: 95, original_price: 120, available_quantity: 7, attributes: [{ id: 'SELLER_SKU', value_name: 'REL-01-ROJ' }], attribute_combinations: [{ name: 'Color', value_name: 'Rojo' }, { name: 'Talla', value_name: 'M' }] },
            { id: 503, price: 90, available_quantity: 0 },
        ],
    };

    it('cada variante con SKU es una fila, con su propio stock y su id de variante', () => {
        const { rows, sinSku } = filasDeItemMeli(conVariantes);
        expect(rows.map(r => [r.sku, r.variationId, r.stock])).toEqual([['REL-01-NEG', '501', 5], ['REL-01-ROJ', '502', 7]]);
        expect(sinSku).toBe(1); // la variante 503 no tiene SKU
        expect(rows.every(r => r.externalId === 'MPE111')).toBe(true);
    });

    it('describe la variante y usa su foto si tiene una propia', () => {
        const { rows } = filasDeItemMeli(conVariantes);
        expect(rows[0].variation).toBe('Color: Negro');
        expect(rows[0].imageUrl).toBe('https://img/2.jpg'); // su picture_ids
        expect(rows[1].variation).toBe('Color: Rojo · Talla: M');
        expect(rows[1].imageUrl).toBe('https://img/1.jpg'); // sin foto propia: la principal
    });

    it('el precio y la promoción se leen por variante', () => {
        const { rows } = filasDeItemMeli(conVariantes);
        expect(rows[0]).toMatchObject({ regularPrice: 90, salePrice: null });
        expect(rows[1]).toMatchObject({ regularPrice: 120, salePrice: 95 });
    });

    it('el SKU de la publicación no se asigna a las variantes que no lo tienen: no se adivina', () => {
        const { rows } = filasDeItemMeli({ ...conVariantes, seller_custom_field: 'GENERAL', variations: [{ id: 1, available_quantity: 3 }] });
        expect(rows).toEqual([]);
    });
});

describe('estado de la publicación', () => {
    it.each([
        [{ status: 'active' }, 'published'],
        [{ status: 'paused' }, 'paused'],
        [{ status: 'closed' }, 'paused'],
        [{ status: 'under_review' }, 'pending'],
        [{ status: 'payment_required' }, 'pending'],
        [{ status: 'active', sub_status: ['suspended'] }, 'error'],
        [{ status: 'paused', sub_status: ['forbidden'] }, 'error'],
    ])('%j → %s', (item, esperado) => {
        expect(estadoDeItemMeli(item)).toBe(esperado);
    });
});
