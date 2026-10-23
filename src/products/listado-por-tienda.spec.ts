import { ProductsService } from './products.service';

/**
 * La lista de productos es de la tienda activa: no mezcla las de otras tiendas del mismo dueño ni deja fuera lo que
 * creó otra persona del equipo. Los filtros y los contadores usan las mismas condiciones.
 */
function construir(filas: any[] = [], resumenDeGrupos: any[] = []) {
    const llamadas: { donde: string[]; params: any[] } = { donde: [], params: [] };
    const qb: any = {};
    for (const m of ['leftJoinAndSelect', 'orderBy', 'skip', 'take', 'select', 'addSelect']) qb[m] = jest.fn(() => qb);
    qb.where = jest.fn((sql: string, p: any) => { llamadas.donde.push(sql); llamadas.params.push(p); return qb; });
    qb.andWhere = jest.fn((sql: string, p: any) => { llamadas.donde.push(sql); llamadas.params.push(p); return qb; });
    qb.getManyAndCount = jest.fn(async () => [filas, filas.length]);
    qb.getMany = jest.fn(async () => []);
    qb.getRawOne = jest.fn(async () => ({ total: '10', sinCategoria: '3', sinPublicar: '4', conError: '1', incompletos: '5' }));
    const repo: any = { createQueryBuilder: jest.fn(() => qb), query: jest.fn(async () => resumenDeGrupos) };
    return { servicio: new ProductsService(repo, {} as any, {} as any), qb, llamadas };
}

describe('lista de productos por tienda', () => {
    it('trae los productos de la tienda activa y los antiguos sin tienda del usuario', async () => {
        const { servicio, llamadas } = construir();
        await servicio.findAll({ userId: 'u1', storeId: 's1' }, {} as any);
        expect(llamadas.donde[0]).toContain('product.storeId = :storeId');
        expect(llamadas.donde[0]).toContain('product.storeId IS NULL AND product.ownerId = :userId');
        expect(llamadas.params[0]).toEqual({ storeId: 's1', userId: 'u1' });
    });

    it.each([
        ['sin-categoria', 'falabella_category_id'],
        ['sin-publicar', "'published', 'pending', 'paused'"],
        ['con-error', "'error'"],
        ['incompletos', 'product_images'],
    ])('el filtro %s se aplica', async (estado, fragmento) => {
        const { servicio, llamadas } = construir();
        await servicio.findAll({ userId: 'u1', storeId: 's1' }, { estado } as any);
        expect(llamadas.donde.some((d) => d.includes(fragmento))).toBe(true);
    });

    it('sin filtros solo añade la regla de una fila por grupo', async () => {
        const { servicio, llamadas } = construir();
        await servicio.findAll({ userId: 'u1', storeId: 's1' }, {} as any);
        expect(llamadas.donde).toHaveLength(2);
        expect(llamadas.donde[1]).toContain('product."groupId" IS NULL');
    });

    it('un grupo de variantes es UNA fila con el resumen de sus variantes', async () => {
        const fila = { id: 'v1', name: 'Polo Rojo S', group: { id: 'g1', name: 'Polo', parentSku: 'POLO' } };
        const { servicio } = construir([fila, { id: 'solo', name: 'Taza', group: null }], [
            { groupId: 'g1', n: '6', pmin: '40.00', pmax: '45.50', stock: '30', ids: ['v1', 'v2', 'v3', 'v4', 'v5', 'v6'] },
        ]);
        const r = await servicio.findAll({ userId: 'u1', storeId: 's1' }, {} as any);
        expect(r.meta.total).toBe(2);
        expect(r.data[0].groupSummary).toEqual({ variantCount: 6, priceMin: 40, priceMax: 45.5, stockTotal: 30, variantIds: ['v1', 'v2', 'v3', 'v4', 'v5', 'v6'] });
        expect(r.data[1].groupSummary).toBeNull();
    });

    it('al desplegar un grupo se piden sus variantes y no se colapsa a una fila', async () => {
        const { servicio, llamadas } = construir();
        await servicio.findAll({ userId: 'u1', storeId: 's1' }, { groupId: 'g1' } as any);
        expect(llamadas.donde.some((d) => d.includes('product."groupId" = :groupId'))).toBe(true);
        expect(llamadas.donde.some((d) => d.includes('product."groupId" IS NULL'))).toBe(false);
    });

    it('buscar y filtrar encuentra el grupo aunque lo que coincida sea otra de sus variantes', async () => {
        const { servicio, llamadas } = construir();
        await servicio.findAll({ userId: 'u1', storeId: 's1' }, { search: 'rojo', estado: 'con-error' } as any);
        const busqueda = llamadas.donde.find((d) => d.includes('ILIKE :q'))!;
        expect(busqueda).toContain('EXISTS (SELECT 1 FROM products s WHERE s."groupId" = product."groupId"');
        const error = llamadas.donde.find((d) => d.includes("'error'"))!;
        expect(error).toContain('EXISTS (SELECT 1 FROM products s WHERE s."groupId" = product."groupId"');
    });

    it('el filtro por canal usa las publicaciones reales (no los canales de destino) y también las de las variantes', async () => {
        const { servicio, llamadas } = construir();
        await servicio.findAll({ userId: 'u1', storeId: 's1' }, { marketplace: 'Falabella' } as any);
        const filtro = llamadas.donde.find((d) => d.includes('listing_links') && d.includes(':mp'))!;
        expect(filtro).toContain("l.\"syncStatus\" <> 'removed'");
        expect(filtro).toContain('EXISTS (SELECT 1 FROM products s WHERE s."groupId" = product."groupId"');
        expect(llamadas.donde.some((d) => d.includes('targetMarketplaces'))).toBe(false);
        expect(llamadas.params.find((p) => p && 'mp' in p)).toEqual({ mp: 'falabella' });
    });

    it('la exportación filtra por canal de la misma forma', async () => {
        const { servicio, llamadas } = construir();
        await servicio.findAllForExport({ userId: 'u1', storeId: 's1' }, { marketplace: 'mercadolibre' } as any);
        expect(llamadas.donde.some((d) => d.includes('listing_links') && d.includes(':mp'))).toBe(true);
    });

    it('el resumen cuenta con las mismas condiciones y devuelve números', async () => {
        const { servicio, qb } = construir();
        const r = await servicio.resumen({ userId: 'u1', storeId: 's1' });
        expect(r).toEqual({ total: 10, sinCategoria: 3, sinPublicar: 4, conError: 1, incompletos: 5 });
        const sql = qb.addSelect.mock.calls.map((c: any[]) => c[0]).join(' ');
        expect(sql).toContain('falabella_category_id');
        expect(sql).toContain('listing_links');
        expect(qb.andWhere.mock.calls.some((c: any[]) => String(c[0]).includes('product."groupId" IS NULL'))).toBe(true);
    });

    it('la exportación también respeta la tienda y el filtro', async () => {
        const { servicio, llamadas } = construir();
        await servicio.findAllForExport({ userId: 'u1', storeId: 's1' }, { estado: 'con-error' } as any);
        expect(llamadas.donde[0]).toContain('product.storeId = :storeId');
        expect(llamadas.donde.some((d) => d.includes("'error'"))).toBe(true);
    });
});
