import { BadRequestException } from '@nestjs/common';
import { ChangeRequestsService } from './change-requests.service';

/**
 * La cola de revisión existe para que un precio mal tecleado no llegue solo
 * a Falabella. Lo que se protege aquí: nada se envía hasta aprobar, aprobar
 * dos veces no envía dos veces, y solo se registran cambios que cambian algo.
 */
function construir(over: { solicitud?: any; producto?: any; claimed?: number } = {}) {
    const guardadas: any[] = [];
    const repo = {
        update: jest.fn().mockResolvedValue({ affected: over.claimed ?? 1 }),
        save: jest.fn(async (e: any) => { guardadas.push(e); return { id: `r${guardadas.length}`, ...e }; }),
        create: jest.fn((e: any) => e),
        findOne: jest.fn().mockResolvedValue(over.solicitud ?? null),
        find: jest.fn().mockResolvedValue([]),
    };
    const productos = {
        findOne: jest.fn().mockResolvedValue(over.producto ?? null),
        save: jest.fn(async (p: any) => p),
    };
    const usuarios = { findOne: jest.fn(), update: jest.fn() };
    const cola = { add: jest.fn() };
    const service = new ChangeRequestsService(repo as any, productos as any, usuarios as any, cola as any);
    return { service, repo, productos, usuarios, cola, guardadas };
}

const producto = { id: 'p1', price: 100, stock: 10 } as any;

describe('modo revisión', () => {
    it('sin ajuste guardado se revisa: es el lado seguro', async () => {
        const { service, usuarios } = construir();
        usuarios.findOne.mockResolvedValue(null);
        await expect(service.isReviewMode('u1')).resolves.toBe(true);
        usuarios.findOne.mockResolvedValue({ syncReviewMode: false });
        await expect(service.isReviewMode('u1')).resolves.toBe(false);
    });

    it('crea una solicitud por canal y por campo que cambia', async () => {
        const { service, guardadas } = construir();
        const creadas = await service.createFromInventory('u1', producto, { price: 90, stock: 4 }, ['falabella', 'mercadolibre']);
        expect(creadas).toHaveLength(4);
        expect(guardadas.map(g => `${g.marketplace}:${g.field}`).sort()).toEqual([
            'falabella:price', 'falabella:stock', 'mercadolibre:price', 'mercadolibre:stock',
        ]);
        expect(guardadas.find(g => g.field === 'price')).toMatchObject({ previousValue: '100', newValue: '90', status: 'pending' });
    });

    it('ignora los campos que no cambian', async () => {
        const { service } = construir();
        const creadas = await service.createFromInventory('u1', producto, { price: 100, stock: 4 }, ['falabella']);
        expect(creadas).toHaveLength(1);
        expect(creadas[0].field).toBe('stock');
    });

    it('reemplaza la solicitud pendiente anterior de lo mismo', async () => {
        const { service, repo } = construir();
        await service.createFromInventory('u1', producto, { stock: 4 }, ['falabella']);
        expect(repo.update).toHaveBeenCalledWith(
            expect.objectContaining({ marketplace: 'falabella', field: 'stock', status: 'pending' }),
            expect.objectContaining({ status: 'rejected' }),
        );
    });

    it('rechaza un filtro de estado inválido', async () => {
        const { service } = construir();
        await expect(service.list('u1', 'inventado')).rejects.toBeInstanceOf(BadRequestException);
    });
});

describe('aprobar y rechazar', () => {
    const solicitud = { id: 'r1', field: 'price', newValue: '90', marketplace: 'falabella', status: 'pending', product: { id: 'p1' } };

    it('aprobar aplica el valor al producto y encola el envío del canal', async () => {
        const { service, productos, cola } = construir({ solicitud, producto: { ...producto } });
        await service.approve('r1', 'u1');
        expect(productos.save).toHaveBeenCalledWith(expect.objectContaining({ price: 90 }));
        expect(cola.add).toHaveBeenCalledWith('inventory', {
            productId: 'p1', userId: 'u1', marketplace: 'falabella', changeRequestId: 'r1',
        });
    });

    it('aprobar una solicitud ya resuelta no encola nada', async () => {
        const { service, cola } = construir({ solicitud, producto: { ...producto }, claimed: 0 });
        await expect(service.approve('r1', 'u1')).rejects.toBeInstanceOf(BadRequestException);
        expect(cola.add).not.toHaveBeenCalled();
    });

    it('rechazar no toca el producto ni la cola', async () => {
        const { service, productos, cola, repo } = construir({ solicitud });
        await service.reject('r1', 'u1', 'precio mal tecleado');
        expect(repo.update).toHaveBeenCalledWith(
            { id: 'r1', status: 'pending' },
            expect.objectContaining({ status: 'rejected', resultMessage: 'precio mal tecleado' }),
        );
        expect(productos.save).not.toHaveBeenCalled();
        expect(cola.add).not.toHaveBeenCalled();
    });

    it('el worker cierra la solicitud como enviada o con error', async () => {
        const { service, repo } = construir();
        await service.markResult('r1', true);
        expect(repo.update).toHaveBeenLastCalledWith({ id: 'r1' }, expect.objectContaining({ status: 'sent' }));
        await service.markResult('r1', false, 'Falabella rechazó el lote');
        expect(repo.update).toHaveBeenLastCalledWith({ id: 'r1' }, expect.objectContaining({ status: 'error', resultMessage: 'Falabella rechazó el lote' }));
    });
});
