import { claseDeEje, InfoVariantesDeCategoria, revisarCompatibilidad } from './compatibilidad-variantes';

const COLORES_RIPLEY = ['Beige', 'Marrón', 'Negro', 'Rosado'];
const ripley = (over: Partial<InfoVariantesDeCategoria> = {}): InfoVariantesDeCategoria => ({
    canal: 'ripley', categoryId: 'R250600000000', ruta: 'CALZADO › SANDALIAS', admite: true,
    ejes: [{ id: 'color_80', label: 'Color', options: COLORES_RIPLEY, required: true }, { id: 'talla_calzado_faceta', label: 'Talla calzado', required: true }],
    ...over,
});
const ejesDeLasSandalias = [{ name: 'Color', values: ['Beige', 'Negro'] }, { name: 'Talla', values: ['35', '36'] }];

describe('claseDeEje', () => {
    it('reconoce el mismo dato con distintos nombres en cada canal', () => {
        expect(claseDeEje('Color')).toBe('color');
        expect(claseDeEje('ColorVariant')).toBe('color');
        expect(claseDeEje('color_80')).toBe('color');
        expect(claseDeEje('COLOR')).toBe('color');
        expect(claseDeEje('Talla')).toBe('talla');
        expect(claseDeEje('Talla calzado')).toBe('talla');
        expect(claseDeEje('SIZE')).toBe('talla');
        expect(claseDeEje('Material')).toBe('material');
        expect(claseDeEje('')).toBe('');
    });
});

describe('revisarCompatibilidad', () => {
    it('ejes que la categoría acepta: una sola publicación, sin avisos', () => {
        const r = revisarCompatibilidad(ejesDeLasSandalias, ripley());
        expect(r.publicaComo).toBe('una');
        expect(r.mapeo).toEqual([{ eje: 'Color', atributo: 'color_80' }, { eje: 'Talla', atributo: 'talla_calzado_faceta' }]);
        expect(r.avisos).toEqual([]);
    });

    it('una categoría que no admite variantes: se publican separadas y se avisa, nombrando el canal', () => {
        const r = revisarCompatibilidad(ejesDeLasSandalias, ripley({ admite: false, ejes: [], ruta: 'MALETERÍA › LONCHERAS' }));
        expect(r.publicaComo).toBe('separadas');
        expect(r.avisos[0]).toContain('MALETERÍA › LONCHERAS');
        expect(r.avisos[0]).toContain('no admite variantes');
        expect(r.avisos[0]).toContain('separados en Ripley');
    });

    it('un eje que la categoría no acepta: separadas, y dice cuáles ejes acepta', () => {
        const r = revisarCompatibilidad([{ name: 'Color', values: ['Beige'] }, { name: 'Material', values: ['Cuero', 'Tela'] }], ripley());
        expect(r.publicaComo).toBe('separadas');
        expect(r.ejesNoPermitidos).toEqual(['Material']);
        expect(r.avisos[0]).toContain('«Material»');
        expect(r.avisos[0]).toContain('acepta: «Color», «Talla calzado»');
        expect(r.avisos[0]).toContain('separados');
    });

    it('un dato de variante que la categoría exige y el producto no tiene: avisa pero no impide agrupar', () => {
        const r = revisarCompatibilidad([{ name: 'Color', values: ['Beige'] }], ripley());
        expect(r.publicaComo).toBe('una');
        expect(r.ejesQueFaltan).toEqual(['Talla calzado']);
        expect(r.avisos.join(' ')).toContain('Talla calzado');
    });

    it('un valor que no existe en la lista del canal se avisa (por ejemplo un color)', () => {
        const r = revisarCompatibilidad([{ name: 'Color', values: ['Beige', 'Fucsia'] }, { name: 'Talla', values: ['35'] }], ripley());
        expect(r.publicaComo).toBe('una');
        expect(r.valoresSinEquivalente).toEqual([{ eje: 'Color', valores: ['Fucsia'] }]);
        expect(r.avisos.join(' ')).toContain('«Fucsia»');
    });

    it('un valor parecido de la lista cuenta como equivalente («marron» → «Marrón»)', () => {
        const r = revisarCompatibilidad([{ name: 'Color', values: ['marron'] }, { name: 'Talla', values: ['35'] }], ripley());
        expect(r.valoresSinEquivalente).toEqual([]);
    });

    it('un canal sin categorías de variante acepta cualquier eje hasta su máximo', () => {
        const shopify: InfoVariantesDeCategoria = { canal: 'shopify', categoryId: null, admite: true, ejes: [], libre: true, maxEjes: 3 };
        expect(revisarCompatibilidad([{ name: 'Material', values: ['A'] }], shopify).publicaComo).toBe('una');
        const mucho = revisarCompatibilidad([1, 2, 3, 4].map((n) => ({ name: `E${n}`, values: ['a'] })), shopify);
        expect(mucho.publicaComo).toBe('separadas');
        expect(mucho.avisos[0]).toContain('hasta 3 ejes');
    });

    it('un eje con un solo valor («Modelo: CANGURO») no impide la publicación única: solo cuentan los ejes que varían', () => {
        const ejes = [{ name: 'Modelo', values: ['CANGURO'] }, { name: 'Color', values: ['Rosado', 'Negro', 'Rojo', 'Crema'] }];
        const r = revisarCompatibilidad(ejes, ripley({ ruta: 'MALETERÍA › CANGUROS', ejes: [{ id: 'color_80', label: 'Color', options: ['Rosado', 'Negro', 'Rojo', 'Crema'], required: true }] }));
        expect(r.publicaComo).toBe('una');
        expect(r.mapeo).toEqual([{ eje: 'Color', atributo: 'color_80' }]);
        expect(r.ejesNoPermitidos).toEqual([]);
        expect(r.avisos).toEqual([]);
    });

    it('pero un eje que SÍ varía y la categoría no acepta sigue obligando a publicar por separado', () => {
        const ejes = [{ name: 'Modelo', values: ['CANGURO', 'MORRAL'] }, { name: 'Color', values: ['Rosado', 'Negro'] }];
        const r = revisarCompatibilidad(ejes, ripley({ ejes: [{ id: 'color_80', label: 'Color', options: ['Rosado', 'Negro'], required: true }] }));
        expect(r.publicaComo).toBe('separadas');
        expect(r.ejesNoPermitidos).toEqual(['Modelo']);
    });

    it('en un canal libre (Shopify, WooCommerce) un eje de un solo valor no cuenta contra el máximo de ejes', () => {
        const libre: InfoVariantesDeCategoria = { canal: 'shopify', categoryId: null, admite: true, ejes: [], libre: true, maxEjes: 2 } as any;
        const ejes = [{ name: 'Modelo', values: ['CANGURO'] }, { name: 'Color', values: ['Rosado', 'Negro'] }, { name: 'Talla', values: ['S', 'M'] }];
        const r = revisarCompatibilidad(ejes, libre);
        expect(r.publicaComo).toBe('una');
        expect(r.mapeo.map((m) => m.eje)).toEqual(['Color', 'Talla']);
        // Con tres ejes que sí varían, el máximo se sigue respetando.
        const tres = [{ name: 'Color', values: ['A', 'B'] }, { name: 'Talla', values: ['S', 'M'] }, { name: 'Material', values: ['X', 'Y'] }];
        expect(revisarCompatibilidad(tres, libre).publicaComo).toBe('separadas');
    });

    it('la regla es la misma para Falabella y Mercado Libre: un eje fijo que su categoría no acepta no las separa', () => {
        const ejes = [{ name: 'Modelo', values: ['CANGURO'] }, { name: 'Color', values: ['Rojo', 'Negro'] }];
        for (const canal of ['falabella', 'mercadolibre']) {
            const info: InfoVariantesDeCategoria = { canal, categoryId: '1', ruta: 'X', admite: true, ejes: [{ id: 'ColorVariant', label: 'Color', required: false }] } as any;
            expect(revisarCompatibilidad(ejes, info).publicaComo).toBe('una');
        }
    });

    it('un producto sin ejes no tiene nada que revisar', () => {
        expect(revisarCompatibilidad([], ripley()).publicaComo).toBe('una');
    });

    it('el aviso nombra el canal correcto: lo mismo vale para Falabella y Mercado Libre', () => {
        const fb: InfoVariantesDeCategoria = { canal: 'falabella', categoryId: '3223', ruta: null, admite: false, ejes: [] };
        const ml: InfoVariantesDeCategoria = { canal: 'mercadolibre', categoryId: 'MPE1', ruta: null, admite: false, ejes: [] };
        expect(revisarCompatibilidad(ejesDeLasSandalias, fb).avisos[0]).toContain('separados en Falabella');
        expect(revisarCompatibilidad(ejesDeLasSandalias, ml).avisos[0]).toContain('separados en Mercado Libre');
    });

    it('Falabella con campos «…Variant» mapea sus ejes aunque el nombre cambie', () => {
        const fb: InfoVariantesDeCategoria = { canal: 'falabella', categoryId: '1', admite: true, ejes: [{ id: 'ColorVariant', label: 'Color variante' }, { id: 'TamanoVariant', label: 'Tamaño' }] };
        const r = revisarCompatibilidad([{ name: 'Color', values: ['Rojo'] }], fb);
        expect(r.publicaComo).toBe('una');
        expect(r.mapeo).toEqual([{ eje: 'Color', atributo: 'ColorVariant' }]);
    });
});
