import { planearGruposDeFalabella } from './falabella/variantes-falabella';
import { FalabellaVariantImportService } from './falabella-variant-import.service';

/**
 * Importar de Falabella conservando la estructura de variantes: las fichas con el mismo ParentSku forman un grupo,
 * los ejes salen de los atributos que cambian entre ellas, y cada variante conserva sus propias fotos.
 */
const ficha = (sku: string, over: any = {}) => ({ SellerSku: sku, Name: `Juego de Sábanas Royal ${sku}`, ParentSku: 'SAB-ROYAL', Variation: '', ProductData: {}, ...over });

describe('plan de variantes desde Falabella', () => {
    it('Color y Plazas: cada ficha es una variante con sus valores, y los ejes salen en orden', () => {
        const { grupos, sinResolver } = planearGruposDeFalabella([
            ficha('SAB-BE-2', { Name: 'Juego de Sábanas Royal Textil Beige', ProductData: { Color: 'Beige', Plazas: '2 Plazas' } }),
            ficha('SAB-BL-2', { Name: 'Juego de Sábanas Royal Textil Blanco', ProductData: { Color: 'Blanco', Plazas: '2 Plazas' } }),
            ficha('SAB-BE-25', { Name: 'Juego de Sábanas Royal Textil Beige', ProductData: { Color: 'Beige', Plazas: '2.5 Plazas' } }),
        ]);
        expect(sinResolver).toEqual([]);
        expect(grupos).toHaveLength(1);
        expect(grupos[0].parentSku).toBe('SAB-ROYAL');
        expect(grupos[0].axes).toEqual([{ name: 'Color', values: ['Beige', 'Blanco'] }, { name: 'Plazas', values: ['2 Plazas', '2.5 Plazas'] }]);
        expect(grupos[0].variants).toEqual([
            { sellerSku: 'SAB-BE-2', values: { Color: 'Beige', Plazas: '2 Plazas' } },
            { sellerSku: 'SAB-BL-2', values: { Color: 'Blanco', Plazas: '2 Plazas' } },
            { sellerSku: 'SAB-BE-25', values: { Color: 'Beige', Plazas: '2.5 Plazas' } },
        ]);
        expect(grupos[0].name).toBe('Juego de Sábanas Royal Textil');
    });

    it('un atributo que todas las fichas tienen igual no es un eje; uno que cambia sí', () => {
        const { grupos } = planearGruposDeFalabella([
            ficha('A', { ProductData: { Color: 'Rojo', Material: 'Algodón' } }),
            ficha('B', { ProductData: { Color: 'Azul', Material: 'Algodón' } }),
        ]);
        expect(grupos[0].axes.map((e) => e.name)).toEqual(['Color']);
    });

    it('un atributo que falta en alguna ficha no se usa como eje', () => {
        const { grupos, sinResolver } = planearGruposDeFalabella([
            ficha('A', { ProductData: { Color: 'Rojo', Talla: 'S' } }),
            ficha('B', { ProductData: { Color: 'Azul' } }),
        ]);
        expect(grupos[0].axes.map((e) => e.name)).toEqual(['Color']);
        expect(sinResolver).toEqual([]);
    });

    it('los productos sueltos (ParentSku igual a su SKU o sin ParentSku) no forman grupo', () => {
        const { grupos, sinResolver } = planearGruposDeFalabella([
            ficha('A', { ParentSku: 'A', ProductData: { Color: 'Rojo' } }),
            ficha('B', { ParentSku: 'B', ProductData: { Color: 'Azul' } }),
            ficha('C', { ParentSku: '', ProductData: { Color: 'Verde' } }),
        ]);
        expect(grupos).toEqual([]);
        expect(sinResolver).toEqual([]);
    });

    it('si no hay atributos que las distingan, usa la variación escrita por el vendedor', () => {
        const { grupos } = planearGruposDeFalabella([
            ficha('A', { Variation: 'Hello Kitty' }),
            ficha('B', { Variation: 'Kuromi' }),
        ]);
        expect(grupos[0].axes).toEqual([{ name: 'Variación', values: ['Hello Kitty', 'Kuromi'] }]);
    });

    it('si no se pueden distinguir con certeza, no se arma el grupo y se explica por qué', () => {
        const { grupos, sinResolver } = planearGruposDeFalabella([
            ficha('A', { ProductData: { Color: 'Rojo' } }),
            ficha('B', { ProductData: { Color: 'Rojo' } }),
        ]);
        expect(grupos).toEqual([]);
        expect(sinResolver[0]).toMatchObject({ parentSku: 'SAB-ROYAL', skus: ['A', 'B'] });
        expect(sinResolver[0].motivo).toMatch(/en qué se diferencian/);
    });

    it('combinaciones repetidas (dos fichas Rojo/S) no se agrupan', () => {
        const { grupos, sinResolver } = planearGruposDeFalabella([
            ficha('A', { ProductData: { Color: 'Rojo', Talla: 'S' } }),
            ficha('B', { ProductData: { Color: 'Rojo', Talla: 'S' } }),
            ficha('C', { ProductData: { Color: 'Azul', Talla: 'S' } }),
        ]);
        expect(grupos).toEqual([]);
        expect(sinResolver).toHaveLength(1);
    });

    it('el valor se respeta tal como lo escribió el vendedor y los repetidos con otra escritura son el mismo valor', () => {
        const { grupos } = planearGruposDeFalabella([
            ficha('A', { ProductData: { Color: 'Rojo' } }),
            ficha('B', { ProductData: { Color: 'azul' } }),
            ficha('C', { ProductData: { Color: 'ROJO ' } }),
        ]);
        // «Rojo» y «ROJO» son el mismo valor del eje: dos fichas con la misma combinación no se agrupan.
        expect(grupos).toEqual([]);
    });
});

describe('FalabellaVariantImportService', () => {
    function construir(existentes: any[] = [], enGrupo: Record<string, string | null> = {}) {
        const grupos = [...existentes];
        const productos: any = {
            find: jest.fn(async ({ where }: any) => (where.id._value as string[]).map((id) => ({ id, group: enGrupo[id] ? { id: enGrupo[id] } : null }))),
            update: jest.fn(async () => undefined),
        };
        const repoGrupos: any = {
            find: jest.fn(async () => grupos),
            create: jest.fn((d: any) => ({ ...d })),
            save: jest.fn(async (g: any) => { if (!g.id) { g.id = `g${grupos.length + 1}`; grupos.push(g); } return g; }),
        };
        return { servicio: new FalabellaVariantImportService(productos, repoGrupos), productos, repoGrupos, grupos };
    }
    const scope = { userId: 'u1', storeId: 's1' };
    const plan = { parentSku: 'SAB-ROYAL', name: 'Juego de Sábanas Royal Textil', axes: [{ name: 'Color', values: ['Beige', 'Blanco'] }], variants: [{ sellerSku: 'A', values: { Color: 'Beige' } }, { sellerSku: 'B', values: { Color: 'Blanco' } }] };
    const porSku = () => new Map<string, any>([['A', { id: 'pa', sku: 'A', images: [{ url: 'beige.jpg' }] }], ['B', { id: 'pb', sku: 'B', images: [{ url: 'blanco.jpg' }] }]]);

    it('crea el grupo y enlaza cada variante con SOLO su grupo y sus valores (las fotos no se tocan)', async () => {
        const { servicio, productos, grupos } = construir();
        const r = await servicio.aplicar(scope, [plan], porSku());
        expect(r).toMatchObject({ gruposCreados: 1, variantesAgrupadas: 2, omitidos: [] });
        expect(grupos[0]).toMatchObject({ name: 'Juego de Sábanas Royal Textil', parentSku: 'SAB-ROYAL', axes: plan.axes });
        expect(productos.update).toHaveBeenCalledWith('pa', { group: { id: grupos[0].id }, variantValues: { Color: 'Beige' } });
        expect(productos.update).toHaveBeenCalledWith('pb', { group: { id: grupos[0].id }, variantValues: { Color: 'Blanco' } });
        // Ninguna actualización incluye fotos, precio, stock ni nombre.
        for (const [, datos] of productos.update.mock.calls) expect(Object.keys(datos).sort()).toEqual(['group', 'variantValues']);
    });

    it('volver a importar no duplica el grupo: reutiliza el existente y suma valores nuevos', async () => {
        const existente = { id: 'g1', parentSku: 'sab-royal ', name: 'X', axes: [{ name: 'Color', values: ['Beige'] }] };
        const { servicio, grupos } = construir([existente]);
        const r = await servicio.aplicar(scope, [plan], porSku());
        expect(grupos).toHaveLength(1);
        expect(r).toMatchObject({ gruposCreados: 0, gruposActualizados: 1, variantesAgrupadas: 2 });
        expect(grupos[0].axes).toEqual([{ name: 'Color', values: ['Beige', 'Blanco'] }]);
    });

    it('no mueve un producto que ya pertenece a otro grupo', async () => {
        const { servicio, productos } = construir([], { pa: 'otro' });
        const r = await servicio.aplicar(scope, [plan], porSku());
        expect(r.variantesAgrupadas).toBe(1);
        expect(productos.update).toHaveBeenCalledTimes(1);
        expect(r.omitidos[0].motivo).toMatch(/ya pertenece a otro grupo/);
    });

    it('un grupo con ejes distintos al ya existente se omite y se explica', async () => {
        const { servicio } = construir([{ id: 'g1', parentSku: 'SAB-ROYAL', name: 'X', axes: [{ name: 'Talla', values: ['S'] }] }]);
        const r = await servicio.aplicar(scope, [plan], porSku());
        expect(r.variantesAgrupadas).toBe(0);
        expect(r.omitidos[0].motivo).toMatch(/otros ejes/);
    });

    it('si solo una variante está en esta tienda, no arma el grupo', async () => {
        const { servicio, grupos } = construir();
        const r = await servicio.aplicar(scope, [plan], new Map([['A', { id: 'pa', sku: 'A' } as any]]));
        expect(grupos).toHaveLength(0);
        expect(r.omitidos[0].motivo).toMatch(/menos de dos/);
    });
});

describe('agrupar a mano (último recurso)', () => {
    function construir(productosEnTienda: any[]) {
        const grupos: any[] = [];
        const qb: any = {};
        qb.where = jest.fn(() => qb);
        qb.andWhere = jest.fn(() => qb);
        qb.getMany = jest.fn(async () => productosEnTienda);
        const productos: any = {
            createQueryBuilder: jest.fn(() => qb),
            find: jest.fn(async () => productosEnTienda.map((p) => ({ id: p.id, group: null }))),
            update: jest.fn(async () => undefined),
        };
        const repoGrupos: any = {
            find: jest.fn(async () => grupos),
            create: jest.fn((d: any) => ({ ...d })),
            save: jest.fn(async (g: any) => { if (!g.id) { g.id = 'g1'; grupos.push(g); } return g; }),
        };
        return { servicio: new FalabellaVariantImportService(productos, repoGrupos), productos, grupos };
    }
    const scope = { userId: 'u1', storeId: 's1' };
    const enTienda = [{ id: 'p1', sku: 'CN-26-RO' }, { id: 'p2', sku: 'CN-26-UV' }];
    const entrada = (over: any = {}) => ({
        parentSku: 'CN-26', name: 'Edredón Importado', axes: ['Color'],
        variants: [{ sellerSku: 'CN-26-RO', values: { Color: 'Rosa' } }, { sellerSku: 'CN-26-UV', values: { Color: 'Uva' } }],
        ...over,
    });

    it('crea el grupo con el eje y los valores que definió la persona, sin tocar fotos ni precio', async () => {
        const { servicio, productos, grupos } = construir(enTienda);
        const r = await servicio.agruparManual(scope, entrada());
        expect(r).toMatchObject({ gruposCreados: 1, variantesAgrupadas: 2 });
        expect(grupos[0]).toMatchObject({ name: 'Edredón Importado', parentSku: 'CN-26', axes: [{ name: 'Color', values: ['Rosa', 'Uva'] }] });
        expect(productos.update).toHaveBeenCalledWith('p1', { group: { id: 'g1' }, variantValues: { Color: 'Rosa' } });
        for (const [, datos] of productos.update.mock.calls) expect(Object.keys(datos).sort()).toEqual(['group', 'variantValues']);
    });

    it('rechaza dos variantes con la misma combinación', async () => {
        const { servicio } = construir(enTienda);
        await expect(servicio.agruparManual(scope, entrada({ variants: [{ sellerSku: 'CN-26-RO', values: { Color: 'Rosa' } }, { sellerSku: 'CN-26-UV', values: { Color: 'rosa' } }] }))).rejects.toThrow(/misma combinación/);
    });

    it('rechaza una variante sin valor en algún eje', async () => {
        const { servicio } = construir(enTienda);
        await expect(servicio.agruparManual(scope, entrada({ variants: [{ sellerSku: 'CN-26-RO', values: { Color: 'Rosa' } }, { sellerSku: 'CN-26-UV', values: {} }] }))).rejects.toThrow(/Falta un valor válido de "Color"/);
    });

    it('rechaza si algún SKU no está en la tienda y dice cuál', async () => {
        const { servicio } = construir([enTienda[0]]);
        await expect(servicio.agruparManual(scope, entrada())).rejects.toThrow(/CN-26-UV/);
    });

    it('rechaza ejes vacíos o repetidos y menos de dos variantes', async () => {
        const { servicio } = construir(enTienda);
        await expect(servicio.agruparManual(scope, entrada({ axes: [] }))).rejects.toThrow(/de 1 a 3 ejes/);
        await expect(servicio.agruparManual(scope, entrada({ axes: ['Color', 'color'] }))).rejects.toThrow(/de 1 a 3 ejes/);
        await expect(servicio.agruparManual(scope, entrada({ variants: [{ sellerSku: 'CN-26-RO', values: { Color: 'Rosa' } }] }))).rejects.toThrow(/al menos dos/);
    });
});
