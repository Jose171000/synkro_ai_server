process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test';
import { ConflictException } from '@nestjs/common';
import { ProductsService } from './products.service';

/** Repositorio en memoria con un query builder que entiende solo lo que usa la regla de SKU. */
function construir(productos: { id: string; sku: string; name: string; ownerId: string }[]) {
    const repo: any = {
        createQueryBuilder: () => {
            const filtros: ((p: any) => boolean)[] = [];
            let selecciona = false;
            const qb: any = {
                select: () => { selecciona = true; return qb; },
                where: (_c: string, params: any) => { filtros.push((p) => p.ownerId === params.userId); return qb; },
                andWhere: (cond: string, params: any) => {
                    if (cond.includes('<>')) filtros.push((p) => p.id !== params.exceptId);
                    else if (cond.includes('IN')) filtros.push((p) => params.claves.includes(p.sku.trim().toLowerCase()));
                    else if (cond.includes('LOWER(TRIM(:sku))')) filtros.push((p) => p.sku.trim().toLowerCase() === params.sku.trim().toLowerCase());
                    return qb;
                },
                getOne: async () => productos.find((p) => filtros.every((f) => f(p))) ?? null,
                getRawMany: async () => productos.filter((p) => filtros.every((f) => f(p))).map((p) => ({ sku: p.sku.trim().toLowerCase() })),
            };
            void selecciona;
            return qb;
        },
        create: (x: any) => x,
        save: jest.fn(async (x: any) => x),
        findOne: jest.fn(),
    };
    return { service: new ProductsService(repo, {} as any), repo };
}

describe('cada SKU es único', () => {
    const existentes = [{ id: 'p1', sku: 'ABC-1', name: 'Sábanas', ownerId: 'u1' }, { id: 'p2', sku: 'ZZZ', name: 'Otro', ownerId: 'u2' }];

    it('rechaza un SKU repetido aunque cambien mayúsculas o espacios', async () => {
        const { service } = construir(existentes);
        await expect(service.assertSkuLibre('abc-1', 'u1')).rejects.toBeInstanceOf(ConflictException);
        await expect(service.assertSkuLibre('  ABC-1 ', 'u1')).rejects.toThrow(/SKU distinto/);
    });

    it('acepta un SKU nuevo, uno de otro cliente, o el del propio producto al editarlo', async () => {
        const { service } = construir(existentes);
        await expect(service.assertSkuLibre('NUEVO', 'u1')).resolves.toBeUndefined();
        await expect(service.assertSkuLibre('ZZZ', 'u1')).resolves.toBeUndefined();
        await expect(service.assertSkuLibre('ABC-1', 'u1', 'p1')).resolves.toBeUndefined();
    });

    it('create guarda el SKU sin espacios y se niega si ya existe', async () => {
        const { service, repo } = construir(existentes);
        await service.create({ sku: ' NUEVO-2 ', name: 'x', description: 'y' } as any, 'u1');
        expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ sku: 'NUEVO-2' }));
        await expect(service.create({ sku: 'abc-1', name: 'x', description: 'y' } as any, 'u1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('de una lista de SKUs dice cuáles ya existen', async () => {
        const { service } = construir(existentes);
        const r = await service.skusExistentes('u1', ['abc-1 ', 'nuevo', 'ZZZ', '']);
        expect([...r]).toEqual(['abc-1']);
    });
});
