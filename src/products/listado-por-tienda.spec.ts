import { ProductsService } from './products.service';

/**
 * La lista de productos es de la tienda activa: no mezcla las de otras tiendas del mismo dueño ni deja fuera lo que
 * creó otra persona del equipo. Los filtros y los contadores usan las mismas condiciones.
 */
function construir() {
    const llamadas: { donde: string[]; params: any[] } = { donde: [], params: [] };
    const qb: any = {};
    for (const m of ['leftJoinAndSelect', 'orderBy', 'skip', 'take', 'select', 'addSelect']) qb[m] = jest.fn(() => qb);
    qb.where = jest.fn((sql: string, p: any) => { llamadas.donde.push(sql); llamadas.params.push(p); return qb; });
    qb.andWhere = jest.fn((sql: string, p: any) => { llamadas.donde.push(sql); llamadas.params.push(p); return qb; });
    qb.getManyAndCount = jest.fn(async () => [[], 0]);
    qb.getMany = jest.fn(async () => []);
    qb.getRawOne = jest.fn(async () => ({ total: '10', sinCategoria: '3', sinPublicar: '4', conError: '1', incompletos: '5' }));
    const repo: any = { createQueryBuilder: jest.fn(() => qb) };
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

    it('sin filtro de estado no añade condiciones de más', async () => {
        const { servicio, llamadas } = construir();
        await servicio.findAll({ userId: 'u1', storeId: 's1' }, {} as any);
        expect(llamadas.donde).toHaveLength(1);
    });

    it('el resumen cuenta con las mismas condiciones y devuelve números', async () => {
        const { servicio, qb } = construir();
        const r = await servicio.resumen({ userId: 'u1', storeId: 's1' });
        expect(r).toEqual({ total: 10, sinCategoria: 3, sinPublicar: 4, conError: 1, incompletos: 5 });
        const sql = qb.addSelect.mock.calls.map((c: any[]) => c[0]).join(' ');
        expect(sql).toContain('falabella_category_id');
        expect(sql).toContain('listing_links');
    });

    it('la exportación también respeta la tienda y el filtro', async () => {
        const { servicio, llamadas } = construir();
        await servicio.findAllForExport({ userId: 'u1', storeId: 's1' }, { estado: 'con-error' } as any);
        expect(llamadas.donde[0]).toContain('product.storeId = :storeId');
        expect(llamadas.donde.some((d) => d.includes("'error'"))).toBe(true);
    });
});
