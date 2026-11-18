import { ConflictException } from '@nestjs/common';
import { ProductsService } from './products.service';
import { SkuGeneratorService } from './sku-generator.service';

/** Repositorio en memoria: sin productos con ese SKU, y los grupos indicados. */
function repoDeProductos(skus: string[] = []) {
    const qb: any = { select: () => qb, where: () => qb, andWhere: () => qb, getOne: async () => null, getRawMany: async () => skus.map((sku) => ({ sku })) };
    return { createQueryBuilder: () => qb } as any;
}
function repoDeGrupos(grupos: { parentSku: string; name: string }[]) {
    const qb: any = { select: () => qb, where: () => qb, andWhere: () => qb, getMany: async () => grupos, getRawMany: async () => grupos.map((g) => ({ sku: g.parentSku })) };
    return { createQueryBuilder: () => qb } as any;
}

describe('un SKU de producto no puede ser el código de un grupo de variantes', () => {
    const ambito = { userId: 'u1', storeId: 't1' };

    it('crear un producto con el código de un grupo se rechaza con un mensaje claro', async () => {
        const servicio = new ProductsService(repoDeProductos(), {} as any, {} as any, undefined, undefined, repoDeGrupos([{ parentSku: '23090103', name: 'Rizador automático' }]));
        await expect(servicio.assertSkuLibre('23090103', ambito)).rejects.toBeInstanceOf(ConflictException);
        await expect(servicio.assertSkuLibre('23090103', ambito)).rejects.toThrow(/código del grupo de variantes "Rizador automático"/);
    });

    it('sin grupo con ese código el SKU queda libre', async () => {
        const servicio = new ProductsService(repoDeProductos(), {} as any, {} as any, undefined, undefined, repoDeGrupos([]));
        await expect(servicio.assertSkuLibre('23090104', ambito)).resolves.toBeUndefined();
    });

    it('la lista de SKU existentes (carga masiva, variantes) incluye los códigos de grupo', async () => {
        const servicio = new ProductsService(repoDeProductos(['abc-1']), {} as any, {} as any, undefined, undefined, repoDeGrupos([{ parentSku: '23090103', name: 'Rizador' }]));
        const r = await servicio.skusExistentes(ambito, ['ABC-1', '23090103', 'libre']);
        expect(r.has('abc-1')).toBe(true);
        expect(r.has('23090103')).toBe(true);
        expect(r.has('libre')).toBe(false);
    });
});

describe('el generador de SKU salta los códigos de grupo', () => {
    it('si el siguiente número es el código de un grupo, devuelve el que sigue', async () => {
        const productos: any = { createQueryBuilder: () => { const qb: any = { select: () => qb, addSelect: () => qb, innerJoin: () => qb, where: () => qb, andWhere: () => qb, groupBy: () => qb, orderBy: () => qb, limit: () => qb, getRawMany: async () => [{ sku: 'C0010' }] }; return qb; } };
        const tiendas: any = { listMine: jest.fn(async () => ({ stores: [{ id: 't1', name: 'Kassari' }] })) };
        const generador = new SkuGeneratorService(productos, tiendas, repoDeGrupos([{ parentSku: 'C0011', name: 'Familia' }]));
        expect(await generador.siguientes({ userId: 'u1', storeId: 't1' })).toEqual(['C0012']);
    });
});
