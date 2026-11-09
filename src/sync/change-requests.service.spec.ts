import { BadRequestException } from '@nestjs/common';
import { ChangeRequestsService } from './change-requests.service';

/**
 * La cola de revisión existe para que un precio mal tecleado no llegue solo
 * a Falabella. Lo que se protege aquí: nada se envía hasta aprobar, aprobar
 * dos veces no envía dos veces, solo se registran cambios que cambian algo,
 * y cada cambio va a UNA cuenta del canal (una tienda puede tener varias).
 */
const SCOPE = { userId: 'u1', storeId: 't1' };

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
    const tiendas = { findOne: jest.fn(), update: jest.fn() };
    const cola = { add: jest.fn() };
    const service = new ChangeRequestsService(repo as any, productos as any, tiendas as any, cola as any);
    return { service, repo, productos, tiendas, cola, guardadas };
}

const producto = { id: 'p1', price: 100, stock: 10 } as any;

describe('modo revisión de la tienda', () => {
    it('sin ajuste guardado se revisa: es el lado seguro', async () => {
        const { service, tiendas } = construir();
        tiendas.findOne.mockResolvedValue(null);
        await expect(service.isReviewMode('t1')).resolves.toBe(true);
        tiendas.findOne.mockResolvedValue({ syncReviewMode: false });
        await expect(service.isReviewMode('t1')).resolves.toBe(false);
    });

    it('el ajuste se guarda en la tienda, no en la persona', async () => {
        const { service, tiendas } = construir();
        await service.setReviewMode('t1', false);
        expect(tiendas.update).toHaveBeenCalledWith({ id: 't1' }, { syncReviewMode: false });
    });

    it('crea una solicitud por cuenta y por campo que cambia', async () => {
        const { service, guardadas } = construir();
        const creadas = await service.createFromInventory(SCOPE, producto, { price: 90, stock: 4 }, [
            { marketplace: 'falabella', connectionId: 'c-fal-1' },
            { marketplace: 'falabella', connectionId: 'c-fal-2' },
            { marketplace: 'mercadolibre', connectionId: 'c-ml' },
        ]);
        expect(creadas).toHaveLength(6);
        expect(guardadas.map(g => `${g.connection.id}:${g.field}`).sort()).toEqual([
            'c-fal-1:price', 'c-fal-1:stock', 'c-fal-2:price', 'c-fal-2:stock', 'c-ml:price', 'c-ml:stock',
        ]);
        expect(guardadas.find(g => g.field === 'price')).toMatchObject({
            previousValue: '100', newValue: '90', status: 'pending', store: { id: 't1' },
        });
    });

    it('ignora los campos que no cambian', async () => {
        const { service } = construir();
        const creadas = await service.createFromInventory(SCOPE, producto, { price: 100, stock: 4 }, [
            { marketplace: 'falabella', connectionId: 'c1' },
        ]);
        expect(creadas).toHaveLength(1);
        expect(creadas[0].field).toBe('stock');
    });

    it('reemplaza la solicitud pendiente anterior de lo mismo en ESA cuenta', async () => {
        const { service, repo } = construir();
        await service.createFromInventory(SCOPE, producto, { stock: 4 }, [{ marketplace: 'falabella', connectionId: 'c1' }]);
        expect(repo.update).toHaveBeenCalledWith(
            expect.objectContaining({ connection: { id: 'c1' }, field: 'stock', status: 'pending' }),
            expect.objectContaining({ status: 'rejected' }),
        );
    });

    it('rechaza un filtro de estado inválido', async () => {
        const { service } = construir();
        await expect(service.list(SCOPE, 'inventado')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lista las de la tienda, y las antiguas sin tienda solo a quien las pidió', async () => {
        const { service, repo } = construir();
        await service.list(SCOPE, 'pending');
        const donde = repo.find.mock.calls[0][0].where;
        expect(donde).toHaveLength(2);
        expect(donde[0]).toMatchObject({ store: { id: 't1' }, status: 'pending' });
        expect(donde[1]).toMatchObject({ requestedBy: { id: 'u1' } });
    });
});

describe('aprobar y rechazar', () => {
    const solicitud = {
        id: 'r1', field: 'price', newValue: '90', marketplace: 'falabella', status: 'pending',
        product: { id: 'p1' }, connection: { id: 'c1' },
    };

    it('aprobar aplica el valor al producto y encola el envío a esa cuenta', async () => {
        const { service, productos, cola } = construir({ solicitud, producto: { ...producto } });
        await service.approve('r1', SCOPE);
        expect(productos.save).toHaveBeenCalledWith(expect.objectContaining({ price: 90 }));
        expect(cola.add).toHaveBeenCalledWith('inventory', {
            productId: 'p1', userId: 'u1', marketplace: 'falabella', connectionId: 'c1', changeRequestId: 'r1',
            // Ripley manda un solo campo por vez: la solicitud dice cuál.
            conPrecio: true, conStock: false,
        });
    });

    it('un reenvío de precio es una solicitud de precio que reemplaza a otra pendiente de lo mismo', async () => {
        const { service, repo } = construir();
        await service.createPriceResend(SCOPE, { id: 'p1', price: 60 } as any, { marketplace: 'ripley', connectionId: 'c1', channelPrice: 35 });
        expect(repo.update).toHaveBeenCalledWith(
            { product: { id: 'p1' }, connection: { id: 'c1' }, field: 'price', status: 'pending' },
            expect.objectContaining({ status: 'rejected' }),
        );
        expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ field: 'price', previousValue: '35', newValue: '60', marketplace: 'ripley', status: 'pending' }));
    });

    it('un descuento por canal no toca el producto: aprobarlo solo lo manda a esa cuenta, con su valor', async () => {
        const promo = { id: 'r9', field: 'promo', newValue: '120|2026-11-09|2027-09-30', marketplace: 'ripley', status: 'pending', product: { id: 'p1' }, connection: { id: 'c1' } };
        const { service, productos, cola } = construir({ solicitud: promo, producto: { ...producto } });
        await service.approve('r9', SCOPE);
        expect(productos.save).not.toHaveBeenCalled();
        expect(cola.add).toHaveBeenCalledWith('inventory', expect.objectContaining({
            marketplace: 'ripley', connectionId: 'c1', changeRequestId: 'r9', conPrecio: false, conStock: false,
            conDescuento: true, descuento: { precio: 120, desde: '2026-11-09', hasta: '2027-09-30' },
        }));
    });

    it('quitar un descuento viaja como «quitar»; un valor dañado no se envía y la solicitud queda con error', async () => {
        const quitar = { id: 'r8', field: 'promo', newValue: 'quitar', marketplace: 'ripley', status: 'pending', product: { id: 'p1' }, connection: { id: 'c1' } };
        const a = construir({ solicitud: quitar, producto: { ...producto } });
        await a.service.approve('r8', SCOPE);
        expect(a.cola.add).toHaveBeenCalledWith('inventory', expect.objectContaining({ conDescuento: true, descuento: { precio: null } }));

        const mala = { ...quitar, id: 'r7', newValue: 'abc' };
        const b = construir({ solicitud: mala, producto: { ...producto } });
        await expect(b.service.approve('r7', SCOPE)).rejects.toThrow(/no es válido/);
        expect(b.cola.add).not.toHaveBeenCalled();
        expect(b.repo.update).toHaveBeenLastCalledWith({ id: 'r7' }, expect.objectContaining({ status: 'error' }));
    });

    it('crear una solicitud de descuento reemplaza a otra pendiente de lo mismo', async () => {
        const { service, repo } = construir();
        await service.createPromoRequest(SCOPE, { id: 'p1' } as any, { marketplace: 'ripley', connectionId: 'c1', previous: '120', next: '100||' });
        expect(repo.update).toHaveBeenCalledWith(
            { product: { id: 'p1' }, connection: { id: 'c1' }, field: 'promo', status: 'pending' },
            expect.objectContaining({ status: 'rejected' }),
        );
        expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ field: 'promo', previousValue: '120', newValue: '100||', status: 'pending' }));
    });

    it('una solicitud de otra tienda no se puede aprobar', async () => {
        const { service, cola } = construir({ solicitud: null });
        await expect(service.approve('r-ajena', SCOPE)).rejects.toThrow(/no encontrada/i);
        expect(cola.add).not.toHaveBeenCalled();
    });

    it('aprobar una solicitud ya resuelta no encola nada', async () => {
        const { service, cola } = construir({ solicitud, producto: { ...producto }, claimed: 0 });
        await expect(service.approve('r1', SCOPE)).rejects.toBeInstanceOf(BadRequestException);
        expect(cola.add).not.toHaveBeenCalled();
    });

    it('rechazar no toca el producto ni la cola', async () => {
        const { service, productos, cola, repo } = construir({ solicitud });
        await service.reject('r1', SCOPE, 'precio mal tecleado');
        expect(repo.update).toHaveBeenCalledWith(
            { id: 'r1', status: 'pending' },
            expect.objectContaining({ status: 'rejected', resultMessage: 'precio mal tecleado' }),
        );
        expect(productos.save).not.toHaveBeenCalled();
        expect(cola.add).not.toHaveBeenCalled();
    });

    it('una solicitud que el canal omitió a propósito queda «skipped» con su motivo, no «sent»', async () => {
        const { service, repo } = construir();
        await service.markSkipped('r1', 'El envío a Ripley está apagado');
        expect(repo.update).toHaveBeenLastCalledWith({ id: 'r1' }, expect.objectContaining({ status: 'skipped', resultMessage: 'El envío a Ripley está apagado' }));
    });

    it('el worker cierra la solicitud como enviada o con error', async () => {
        const { service, repo } = construir();
        await service.markResult('r1', true);
        expect(repo.update).toHaveBeenLastCalledWith({ id: 'r1' }, expect.objectContaining({ status: 'sent' }));
        await service.markResult('r1', false, 'Falabella rechazó el lote');
        expect(repo.update).toHaveBeenLastCalledWith({ id: 'r1' }, expect.objectContaining({ status: 'error', resultMessage: 'Falabella rechazó el lote' }));
    });
});
