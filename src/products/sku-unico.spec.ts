process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ProductsService } from './products.service';
import { SkuUnicoService } from './sku-unico.service';

type Fila = { id: string; sku: string; name: string; ownerId: string; storeId: string | null };

/** Repositorio en memoria con un query builder que entiende solo lo que usa la regla de SKU. */
function construir(productos: Fila[], opciones: { falla23505?: boolean } = {}) {
    const repo: any = {
        createQueryBuilder: () => {
            const filtros: ((p: Fila) => boolean)[] = [];
            const qb: any = {
                select: () => qb,
                leftJoinAndSelect: () => qb,
                where: (cond: string, params: any) => {
                    if (cond.includes('storeId" = :storeId')) filtros.push((p) => p.storeId === params.storeId);
                    else filtros.push((p) => p.ownerId === params.userId);
                    return qb;
                },
                andWhere: (cond: string, params: any) => {
                    if (cond.includes('IS NULL')) filtros.push((p) => p.storeId === null);
                    else if (cond.includes('<>')) filtros.push((p) => p.id !== params.exceptId);
                    else if (cond.includes('IN')) filtros.push((p) => params.claves.includes(p.sku.trim().toLowerCase()));
                    else if (cond.includes('LOWER(TRIM(:sku))')) filtros.push((p) => p.sku.trim().toLowerCase() === params.sku.trim().toLowerCase());
                    return qb;
                },
                getOne: async () => productos.find((p) => filtros.every((f) => f(p))) ?? null,
                getRawMany: async () => productos.filter((p) => filtros.every((f) => f(p))).map((p) => ({ sku: p.sku.trim().toLowerCase() })),
            };
            return qb;
        },
        create: (x: any) => x,
        manager: { create: (_c: any, x: any) => x },
        save: jest.fn(async (x: any) => {
            if (opciones.falla23505) throw Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'UQ_product_sku_store' });
            return x;
        }),
        findOne: jest.fn(),
    };
    return { service: new ProductsService(repo, {} as any), repo };
}

describe('cada SKU es único dentro de su tienda', () => {
    const existentes: Fila[] = [
        { id: 'p1', sku: 'ABC-1', name: 'Sábanas', ownerId: 'u1', storeId: 'tiendaA' },
        { id: 'p2', sku: 'ZZZ', name: 'Otro', ownerId: 'u2', storeId: 'tiendaC' },
        { id: 'p3', sku: 'VIEJO-1', name: 'De antes de las tiendas', ownerId: 'u1', storeId: null },
    ];

    it('rechaza un SKU repetido en la misma tienda aunque cambien mayúsculas o espacios', async () => {
        const { service } = construir(existentes);
        await expect(service.assertSkuLibre('abc-1', { userId: 'u1', storeId: 'tiendaA' })).rejects.toBeInstanceOf(ConflictException);
        await expect(service.assertSkuLibre('  ABC-1 ', { userId: 'u1', storeId: 'tiendaA' })).rejects.toThrow(/SKU distinto/);
    });

    it('el mismo SKU se puede usar en otra tienda, incluso de la misma cuenta', async () => {
        const { service } = construir(existentes);
        await expect(service.assertSkuLibre('ABC-1', { userId: 'u1', storeId: 'tiendaB' })).resolves.toBeUndefined();
        await expect(service.assertSkuLibre('ZZZ', { userId: 'u1', storeId: 'tiendaA' })).resolves.toBeUndefined();
    });

    it('acepta un SKU nuevo o el del propio producto al editarlo', async () => {
        const { service } = construir(existentes);
        await expect(service.assertSkuLibre('NUEVO', { userId: 'u1', storeId: 'tiendaA' })).resolves.toBeUndefined();
        await expect(service.assertSkuLibre('ABC-1', { userId: 'u1', storeId: 'tiendaA' }, 'p1')).resolves.toBeUndefined();
    });

    it('un producto sin tienda solo compite con los demás sin tienda de su dueño', async () => {
        const { service } = construir(existentes);
        await expect(service.assertSkuLibre('viejo-1', 'u1')).rejects.toBeInstanceOf(ConflictException);
        await expect(service.assertSkuLibre('ABC-1', 'u1')).resolves.toBeUndefined();
    });

    it('create asigna la tienda, guarda el SKU sin espacios y se niega si ya existe en esa tienda', async () => {
        const { service, repo } = construir(existentes);
        await service.create({ sku: ' NUEVO-2 ', name: 'x', description: 'y' } as any, 'u1', 'tiendaA');
        expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ sku: 'NUEVO-2', store: { id: 'tiendaA' } }));
        await expect(service.create({ sku: 'abc-1', name: 'x', description: 'y' } as any, 'u1', 'tiendaA')).rejects.toBeInstanceOf(ConflictException);
    });

    it('si dos cargas a la vez pasan la revisión, el rechazo de la base se vuelve un mensaje claro', async () => {
        const { service } = construir([], { falla23505: true });
        await expect(service.create({ sku: 'RACE-1', name: 'x', description: 'y' } as any, 'u1', 'tiendaA'))
            .rejects.toThrow(/ya está en uso en esta tienda/);
    });

    it('de una lista de SKUs dice cuáles ya existen en la tienda', async () => {
        const { service } = construir(existentes);
        const r = await service.skusExistentes({ userId: 'u1', storeId: 'tiendaA' }, ['abc-1 ', 'nuevo', 'ZZZ', '']);
        expect([...r]).toEqual(['abc-1']);
    });
});

describe('el SKU no se cambia una vez creado', () => {
    function conProducto() {
        const producto: any = { id: 'p1', sku: 'ABC-1', name: 'Sábanas', images: [] };
        const { service, repo } = construir([]);
        repo.findOne.mockResolvedValue(producto);
        return { service, repo, producto };
    }

    it('rechaza un SKU distinto', async () => {
        const { service } = conProducto();
        await expect(service.update('p1', { sku: 'OTRO-9' } as any, 'u1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('acepta el mismo SKU (aunque cambien mayúsculas) y actualiza lo demás sin tocarlo', async () => {
        const { service, producto } = conProducto();
        await service.update('p1', { sku: ' abc-1 ', name: 'Nuevo nombre' } as any, 'u1');
        expect(producto.sku).toBe('ABC-1');
        expect(producto.name).toBe('Nuevo nombre');
    });
});

describe('índices únicos del SKU en la base de datos', () => {
    function servicioConBase(repetidos: any[]) {
        const consultas: string[] = [];
        const dataSource: any = {
            query: jest.fn(async (sql: string) => {
                consultas.push(sql);
                return /GROUP BY/.test(sql) ? repetidos : [];
            }),
        };
        return { service: new SkuUnicoService(dataSource), consultas };
    }

    it('crea los dos índices y solo entonces quita la restricción antigua por cuenta', async () => {
        const { service, consultas } = servicioConBase([]);
        const r = await service.aplicar();
        expect(r.aplicado).toBe(true);
        const orden = consultas.filter((q) => /CREATE UNIQUE INDEX|DROP CONSTRAINT/.test(q));
        expect(orden[0]).toMatch(/UQ_product_sku_store.*"storeId", lower\(btrim\("sku"\)\)/);
        expect(orden[1]).toMatch(/UQ_product_sku_owner_sin_tienda/);
        expect(orden[2]).toMatch(/DROP CONSTRAINT IF EXISTS "UQ_product_sku_owner"/);
    });

    it('si hay SKU repetidos no toca nada (ni índices ni restricción) y avisa', async () => {
        const { service, consultas } = servicioConBase([{ ambito: 'tienda t1', sku: 'c0001', cantidad: '2' }]);
        const r = await service.aplicar();
        expect(r.aplicado).toBe(false);
        expect(r.repetidos).toEqual([{ ambito: 'tienda t1', sku: 'c0001', cantidad: 2 }]);
        expect(consultas.some((q) => /CREATE UNIQUE INDEX|DROP CONSTRAINT/.test(q))).toBe(false);
    });

    it('al arrancar un fallo no tumba el servidor', async () => {
        const dataSource: any = { query: jest.fn(async () => { throw new Error('sin conexión'); }) };
        await expect(new SkuUnicoService(dataSource).onApplicationBootstrap()).resolves.toBeUndefined();
    });
});
