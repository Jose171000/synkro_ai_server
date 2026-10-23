import { familiasPorPagina, idDeProductoEnUrl, leerPaginaPublica, planearGrupoDesdePagina, skuComparable } from './falabella/pagina-publica';
import { FalabellaPublicPageService } from './falabella-public-page.service';

/**
 * Variantes según la página pública de Falabella. Lo que se protege: se lee solo lo que se entiende por completo (si la
 * página cambia o está bloqueada no se adivina nada), cada ficha se empareja por su SKU, y los ejes salen de los valores
 * reales que muestra la página.
 */
const URL_K = 'https://www.falabella.com.pe/falabella-pe/product/153461795/Sabana-Bordada-King/153461796';

const variante = (id: string, sku: string, over: any = {}) => ({
    id,
    name: 'Sábana Bordada',
    attributes: { size: 'King', primaryColor: `${over.color ?? 'Rosado'}|#FFC0CB`, colorName: over.color ?? 'Rosado', colorCode: '#FFC0CB', sizeOrder: 0, ...(over.attributes ?? {}) },
    offerings: over.offerings ?? [{ sellerId: 'SCE0214', sellerName: 'AMERICATEX PERU', offeringId: id, isActive: true, sellerSkuId: sku }],
});

const pagina = (variantes: any[], extra: any = {}) =>
    `<html><head></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: { productData: { id: '153461795', name: 'Sábana Bordada 2000 Hilos', breadCrumb: [{ label: 'Sábanas King' }, { label: 'Sábanas' }, { label: 'Dormitorio - Ropa de Cama' }], attributes: { GSCCategoryId: 'G21040209' }, variants: variantes, ...extra } } },
    })}</script></body></html>`;

const ficha = (sku: string, over: any = {}) => ({ SellerSku: sku, Name: 'Sábana Bordada 2000 Hilos Audrie', ParentSku: 'BL-A6-K-RPA', Url: URL_K, ...over });
const familia = (fichas: any[]) => ({ productId: '153461795', url: URL_K, fichas });

describe('leerPaginaPublica', () => {
    it('lee color, talla y SKU del vendedor de cada variante, y la categoría', () => {
        const r = leerPaginaPublica(pagina([variante('1', 'BL-A6-K-RPA'), variante('2', 'BL-A6-K-NGR', { color: 'Negro' })]));
        expect(r.ok).toBe(true);
        expect(r.productId).toBe('153461795');
        expect(r.categoria).toEqual({ ruta: ['Sábanas King', 'Sábanas', 'Dormitorio - Ropa de Cama'], codigo: 'G21040209' });
        expect(r.variantes).toEqual([
            { variantId: '1', sellerSkus: ['BL-A6-K-RPA'], size: 'King', colorName: 'Rosado', colorCode: '#FFC0CB', atributos: { size: 'King', colorName: 'Rosado' } },
            { variantId: '2', sellerSkus: ['BL-A6-K-NGR'], size: 'King', colorName: 'Negro', colorCode: '#FFC0CB', atributos: { size: 'King', colorName: 'Negro' } },
        ]);
    });

    it('encuentra el producto aunque cambie su lugar dentro de los datos de la página', () => {
        const html = `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { otra: { ruta: { nueva: { variants: [variante('1', 'A'), variante('2', 'B', { color: 'Negro' })] } } } } } })}</script>`;
        expect(leerPaginaPublica(html).ok).toBe(true);
    });

    it.each([
        ['sin datos de la página', '<html><body>Access denied</body></html>'],
        ['datos rotos', '<script id="__NEXT_DATA__">{no es json</script>'],
        ['sin variantes', pagina([], { variants: [] })],
        ['variantes sin ofertas (la página cambió)', pagina([{ id: '1', attributes: { size: 'King' } }])],
        ['variantes sin SKU del vendedor', pagina([variante('1', '', { offerings: [{ offeringId: '1' }] })])],
        ['vacía', ''],
    ])('si la página no tiene la forma esperada (%s) no se adivina: ok = false con motivo', (_c, html) => {
        const r = leerPaginaPublica(html);
        expect(r.ok).toBe(false);
        expect(r.motivo).toBeTruthy();
        expect(r.variantes).toEqual([]);
    });
});

describe('familias y emparejado por SKU', () => {
    it('el identificador del producto sale de la dirección; las fichas con la misma página son una familia', () => {
        expect(idDeProductoEnUrl(URL_K)).toBe('153461795');
        const familias = familiasPorPagina([ficha('A'), ficha('B'), ficha('C', { Url: 'https://www.falabella.com.pe/falabella-pe/product/999/X/1000' }), ficha('D', { Url: '' })] as any);
        expect(familias).toHaveLength(1);
        expect(familias[0].fichas.map((f) => f.SellerSku)).toEqual(['A', 'B']);
    });

    it('«SKU · X» y «X» son el mismo SKU', () => {
        expect(skuComparable('SKU · BL-A6-F-VC')).toBe(skuComparable('BL-A6-F-VC'));
        expect(skuComparable('bl-a6-f-vc ')).toBe(skuComparable('BL-A6-F-VC'));
    });
});

describe('planearGrupoDesdePagina', () => {
    const lectura = (vars: any[]) => leerPaginaPublica(pagina(vars));

    it('Color como eje cuando la talla es igual en todas (King no distingue nada)', () => {
        const { plan } = planearGrupoDesdePagina(
            familia([ficha('BL-A6-K-RPA'), ficha('BL-A6-K-NGR'), ficha('BL-A6-K-BGE')]),
            lectura([variante('1', 'BL-A6-K-RPA', { color: 'Rosado' }), variante('2', 'BL-A6-K-NGR', { color: 'Negro' }), variante('3', 'BL-A6-K-BGE', { color: 'Beige' })]),
            'Sábana Bordada', 'BL-A6-K-RPA',
        );
        expect(plan!.axes).toEqual([{ name: 'Color', values: ['Rosado', 'Negro', 'Beige'] }]);
        expect(plan!.variants).toEqual([
            { sellerSku: 'BL-A6-K-RPA', values: { Color: 'Rosado' } },
            { sellerSku: 'BL-A6-K-NGR', values: { Color: 'Negro' } },
            { sellerSku: 'BL-A6-K-BGE', values: { Color: 'Beige' } },
        ]);
        expect(plan!.origen).toBe('pagina');
    });

    it('Color y Talla cuando ambos cambian', () => {
        const { plan } = planearGrupoDesdePagina(
            familia([ficha('A'), ficha('B'), ficha('C')]),
            lectura([variante('1', 'A', { color: 'Rojo', attributes: { size: 'S' } }), variante('2', 'B', { color: 'Rojo', attributes: { size: 'M' } }), variante('3', 'C', { color: 'Azul', attributes: { size: 'S' } })]),
            'Polo', 'POLO',
        );
        expect(plan!.axes.map((e) => e.name)).toEqual(['Color', 'Talla']);
    });

    it('cualquier otro atributo que cambie entre variantes también es un eje (material, estilo…)', () => {
        const { plan } = planearGrupoDesdePagina(
            familia([ficha('A'), ficha('B'), ficha('C')]),
            lectura([
                variante('1', 'A', { color: 'Rojo', attributes: { material: 'Algodón', tipoDeProducto: 'Sábana' } }),
                variante('2', 'B', { color: 'Azul', attributes: { material: 'Poliéster', tipoDeProducto: 'Sábana' } }),
                variante('3', 'C', { color: 'Rojo', attributes: { material: 'Poliéster', tipoDeProducto: 'Sábana' } }),
            ]),
            'Sábana', 'SAB',
        );
        // «size: King» y «tipoDeProducto: Sábana» son iguales en todas: no son ejes. Color y Material sí.
        expect(plan!.axes.map((e) => e.name)).toEqual(['Color', 'Material']);
    });

    it('los datos técnicos de la página (código de color, orden de talla) no se toman como ejes', () => {
        const r = planearGrupoDesdePagina(familia([ficha('A'), ficha('B')]), lectura([variante('1', 'A', { attributes: { colorCode: '#111111', sizeOrder: '0' } }), variante('2', 'B', { attributes: { colorCode: '#222222', sizeOrder: '1' } })]), 'X', 'X');
        expect(r.plan).toBeNull();
    });

    it('empareja aunque el SKU lleve el prefijo «SKU · »', () => {
        const { plan } = planearGrupoDesdePagina(
            familia([ficha('SKU · BL-A6-F-VC'), ficha('SKU · BL-A6-F-BG')]),
            lectura([variante('1', 'SKU · BL-A6-F-VC', { color: 'Verde cemento' }), variante('2', 'SKU · BL-A6-F-BG', { color: 'Beige' })]),
            'Sábana', 'BL-A6-F-TPR',
        );
        expect(plan!.variants.map((v) => v.values.Color)).toEqual(['Verde cemento', 'Beige']);
    });

    it('si una ficha no aparece en la página, no se arma el grupo y se dice cuál', () => {
        const r = planearGrupoDesdePagina(familia([ficha('A'), ficha('B')]), lectura([variante('1', 'A'), variante('2', 'OTRO', { color: 'Negro' })]), 'X', 'X');
        expect(r.plan).toBeNull();
        expect(r.motivo).toMatch(/no incluye el SKU B/);
    });

    it('si la página no distingue las variantes (mismo color y talla), no se arma el grupo', () => {
        const r = planearGrupoDesdePagina(familia([ficha('A'), ficha('B')]), lectura([variante('1', 'A'), variante('2', 'B')]), 'X', 'X');
        expect(r.plan).toBeNull();
        expect(r.motivo).toMatch(/no distingue/);
    });

    it('una lectura fallida no produce grupo y conserva el motivo', () => {
        const r = planearGrupoDesdePagina(familia([ficha('A'), ficha('B')]), leerPaginaPublica('<html>bloqueado</html>'), 'X', 'X');
        expect(r.plan).toBeNull();
        expect(r.motivo).toMatch(/no trae los datos esperados/);
    });
});

describe('FalabellaPublicPageService', () => {
    const original = global.fetch;
    afterEach(() => { global.fetch = original; });

    it('solo lee direcciones de Falabella', async () => {
        global.fetch = jest.fn() as any;
        const r = await new FalabellaPublicPageService().leer('https://otro-sitio.com/product/1/x');
        expect(r.ok).toBe(false);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('si Falabella bloquea la lectura lo informa como bloqueada y no lo recuerda', async () => {
        global.fetch = jest.fn(async () => ({ ok: false, status: 403, text: async () => '' })) as any;
        const servicio = new FalabellaPublicPageService();
        const r = await servicio.leer(URL_K);
        expect(r).toMatchObject({ ok: false, bloqueada: true });
        (global.fetch as jest.Mock).mockClear();
        await servicio.leer(URL_K);
        expect(global.fetch).toHaveBeenCalledTimes(1); // se volvió a intentar: el bloqueo no queda fijado
    });

    it('una lectura buena se recuerda y no se vuelve a pedir', async () => {
        global.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => pagina([variante('1', 'A'), variante('2', 'B', { color: 'Negro' })]) })) as any;
        const servicio = new FalabellaPublicPageService();
        expect((await servicio.leer(URL_K)).ok).toBe(true);
        expect((await servicio.leer(URL_K)).ok).toBe(true);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const cabeceras = ((global.fetch as jest.Mock).mock.calls[0][1] as any).headers;
        expect(cabeceras['User-Agent']).toMatch(/SynkroAI/); // se identifica con claridad
    });

    it('una red caída no rompe: devuelve ok = false', async () => {
        global.fetch = jest.fn(async () => { throw new Error('red'); }) as any;
        expect((await new FalabellaPublicPageService().leer(URL_K)).ok).toBe(false);
    });
});
