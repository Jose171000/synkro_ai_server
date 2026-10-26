import { detectarDuplicados, elegirDuplicadasAfectables } from './meli/duplicados-meli';
import { MeliListingRow } from './meli/meli-listings';

/**
 * Pausar o cerrar una publicación repetida es una acción real sobre el canal: solo se permite sobre lo que el servidor
 * vuelve a detectar como repetido, nunca sobre la principal de un SKU ni sobre una publicación con variaciones propias.
 */
const fila = (externalId: string, sku: string, over: Partial<MeliListingRow> = {}): MeliListingRow => ({
    sku, externalId, variationId: null, title: 'Producto', variation: null, regularPrice: 10, salePrice: null, stock: 1,
    status: 'published', permalink: null, imageUrl: null, images: [], quality: null, vendidas: 0, currency: 'PEN', ...over,
});

describe('elegirDuplicadasAfectables', () => {
    const filas = [
        fila('MPE1', 'A', { vendidas: 9 }), // principal de A
        fila('MPE2', 'A', { vendidas: 0 }), // repetida de A
        fila('MPE3', 'B'),                  // sin repetir
    ];
    const { secundarias } = detectarDuplicados(filas);

    it('acepta una publicación repetida', () => {
        expect(elegirDuplicadasAfectables(filas, secundarias, ['MPE2'])).toEqual({ aplicables: ['MPE2'], rechazadas: [] });
    });

    it('rechaza la principal de un SKU', () => {
        const r = elegirDuplicadasAfectables(filas, secundarias, ['MPE1']);
        expect(r.aplicables).toEqual([]);
        expect(r.rechazadas[0]).toMatchObject({ externalId: 'MPE1' });
    });

    it('rechaza una publicación que no es repetida y una que no existe', () => {
        const r = elegirDuplicadasAfectables(filas, secundarias, ['MPE3', 'MPE999']);
        expect(r.aplicables).toEqual([]);
        expect(r.rechazadas.map((x) => x.externalId)).toEqual(['MPE3', 'MPE999']);
    });

    it('una publicación con variaciones solo se toca si TODAS sus variaciones son repetidas', () => {
        const mezcla = [
            fila('MPE1', 'A', { vendidas: 9 }),
            fila('MPE5', 'A', { variationId: '1' }), // repetida de A...
            fila('MPE5', 'C', { variationId: '2' }), // ...pero esta variación no lo es
        ];
        const { secundarias: sec } = detectarDuplicados(mezcla);
        expect(elegirDuplicadasAfectables(mezcla, sec, ['MPE5']).aplicables).toEqual([]);
    });

    it('no repite una publicación pedida dos veces', () => {
        expect(elegirDuplicadasAfectables(filas, secundarias, ['MPE2', 'MPE2']).aplicables).toEqual(['MPE2']);
    });
});
