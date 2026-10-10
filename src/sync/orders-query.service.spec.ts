import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrdersQueryService } from './orders-query.service';

/**
 * La pantalla «Ventas» muestra cada línea con su foto y el stock de ahora, y
 * esconde los datos de contacto a quien solo puede leer. El SQL de filtros y
 * orden se prueba aparte contra PostgreSQL; aquí, las reglas.
 */
const ORDEN = {
    id: '11111111-1111-1111-1111-111111111111', marketplace: 'falabella', externalId: '100', orderNumber: '7001',
    orderDate: new Date('2026-10-09T15:00:00Z'), status: 'pending', customerName: 'Lucía Paredes',
    shipByDate: new Date('2026-10-13T04:59:59Z'), totalAmount: '149.90', currency: 'PEN', itemsCount: 1,
    connection: { id: 'c1', label: 'Cuenta Perú', externalNickname: 'x@f.com', externalUserId: 'x@f.com' },
    owner: { id: 'u1' },
    items: [
        { sku: 'GAF-01', title: 'Gafas de sol', quantity: 1, unitPrice: 149.9, stockBefore: 5, stockAfter: 4 },
        { sku: 'SIN-CATALOGO', title: 'Otro', quantity: 1, unitPrice: 10 },
    ],
    details: {
        customer: { name: 'Lucía Paredes', email: 'l@x.com', phone: '999', document: '123' },
        shipping: { method: 'Dropshipping', status: 'pending', trackingCode: 'TRK1', carrier: 'Olva', shipBy: '2026-10-13T04:59:59Z', deliveryBy: null,
            address: { line: 'Av. Primavera 123', city: 'Surco', region: 'Lima', country: 'Perú', postalCode: '15023', receiver: 'Lucía', notes: 'Portón verde' } },
        payment: { method: 'CreditCard', status: null, paidAmount: 149.9, installments: null, approvedAt: null },
        notes: null, channelStatus: 'pending',
    },
};

function construir(ordenes: any[] = [ORDEN]) {
    const llamadas: { where: string[]; params: any[] } = { where: [], params: [] };
    const qb: any = {
        leftJoinAndSelect: jest.fn(() => qb), leftJoin: jest.fn(() => qb), addSelect: jest.fn(() => qb),
        where: jest.fn((w: string, p: any) => { llamadas.where.push(w); llamadas.params.push(p); return qb; }),
        andWhere: jest.fn((w: string, p: any) => { llamadas.where.push(w); llamadas.params.push(p); return qb; }),
        orderBy: jest.fn(() => qb), addOrderBy: jest.fn(() => qb), take: jest.fn(() => qb), skip: jest.fn(() => qb),
        getManyAndCount: jest.fn(async () => [ordenes, ordenes.length]),
        getOne: jest.fn(async () => ordenes[0] ?? null),
    };
    const repoOrdenes = { createQueryBuilder: jest.fn(() => qb) };
    const repoProductos = {
        find: jest.fn(async () => [{ id: 'p1', sku: 'GAF-01', name: 'Gafas de sol', stock: 4, images: [{ url: 'https://img/gafas.jpg' }] }]),
    };
    const repoEnlaces = { find: jest.fn(async (): Promise<any[]> => []) };
    const service = new OrdersQueryService(repoOrdenes as any, repoProductos as any, repoEnlaces as any);
    return { service, qb, llamadas, repoProductos, repoEnlaces };
}

describe('listado de ventas', () => {
    it('cada línea trae el stock de después, el stock de ahora y la foto del producto', async () => {
        const { service } = construir();
        const r = await service.list('t1', 'owner', {});
        const linea = r.items[0].lines[0];
        expect(linea).toMatchObject({
            sku: 'GAF-01', unitPrice: 149.9, stockBefore: 5, stockAfter: 4, currentStock: 4,
            imageUrl: 'https://img/gafas.jpg', productId: 'p1', productName: 'Gafas de sol',
        });
    });

    it('una línea cuyo SKU ya no está en el catálogo igual se muestra, sin foto ni stock actual', async () => {
        const { service } = construir();
        const r = await service.list('t1', 'owner', {});
        expect(r.items[0].lines[1]).toMatchObject({ sku: 'SIN-CATALOGO', currentStock: null, imageUrl: null });
    });

    it('si el producto no tiene foto propia, usa la de su publicación', async () => {
        const { service, repoProductos, repoEnlaces } = construir();
        repoProductos.find.mockResolvedValue([{ id: 'p1', sku: 'GAF-01', name: 'Gafas', stock: 4, images: [] }]);
        repoEnlaces.find.mockResolvedValue([{ imageUrl: 'https://img/enlace.jpg', product: { id: 'p1' } }]);
        const r = await service.list('t1', 'owner', {});
        expect(r.items[0].lines[0].imageUrl).toBe('https://img/enlace.jpg');
    });

    it('muestra el cliente, la fecha límite, la cuenta y el importe como número', async () => {
        const { service } = construir();
        const [v] = (await service.list('t1', 'owner', {})).items;
        expect(v).toMatchObject({
            orderNumber: '7001', customerName: 'Lucía Paredes', totalAmount: 149.9, currency: 'PEN',
            account: { id: 'c1', label: 'Cuenta Perú' },
        });
        expect(v.shipByDate).toEqual(ORDEN.shipByDate);
    });

    it('siempre filtra por la tienda: no hay forma de pedir ventas de otra', async () => {
        const { service, llamadas } = construir();
        await service.list('tienda-x', 'owner', { from: '2026-10-01', to: '2026-10-31' });
        expect(llamadas.where[0]).toMatch(/storeId/);
        expect(llamadas.params[0]).toEqual({ storeId: 'tienda-x' });
    });

    it('rechaza fechas con formato inválido (nada llega a la consulta)', async () => {
        const { service, qb } = construir();
        await expect(service.list('t1', 'owner', { from: "2026-10-01' OR 1=1" })).rejects.toBeInstanceOf(BadRequestException);
        expect(qb.getManyAndCount).not.toHaveBeenCalled();
    });

    it('limita el tamaño de página', async () => {
        const { service, qb } = construir();
        await service.list('t1', 'owner', { limit: 99999 });
        expect(qb.take).toHaveBeenCalledWith(200);
    });

    it('la búsqueda escapa los comodines para no abrir la consulta de más', async () => {
        const { service, llamadas } = construir();
        await service.list('t1', 'owner', { search: '100%_x' });
        const p = llamadas.params.find(x => x?.q);
        expect(p.q).toBe('%100\\%\\_x%');
    });
});

describe('quién ve los datos de contacto', () => {
    it('el dueño y el editor ven teléfono, correo, documento y dirección', async () => {
        for (const rol of ['owner', 'editor'] as const) {
            const { service } = construir();
            const d: any = await service.detail('t1', rol, ORDEN.id);
            expect(d.details.customer).toMatchObject({ phone: '999', email: 'l@x.com', document: '123' });
            expect(d.details.shipping.address.line).toBe('Av. Primavera 123');
        }
    });

    it('un lector ve la venta pero no los datos de contacto', async () => {
        const { service } = construir();
        const d: any = await service.detail('t1', 'viewer', ORDEN.id);
        expect(d.customerName).toBe('Lucía Paredes');
        expect(d.details.customer).toMatchObject({ phone: null, email: null, document: null });
        expect(d.details.shipping.address).toMatchObject({ line: null, postalCode: null, city: 'Surco' });
        expect(d.details.shipping.trackingCode).toBe('TRK1');
    });

    it('el listado no incluye el bloque de detalles completo', async () => {
        const { service } = construir();
        const [v] = (await service.list('t1', 'owner', {})).items as any[];
        expect(v.details).toBeUndefined();
    });

    it('una venta de otra tienda o un id inválido responde «no encontrada»', async () => {
        const vacia = construir([]);
        await expect(vacia.service.detail('t1', 'owner', '22222222-2222-2222-2222-222222222222')).rejects.toBeInstanceOf(NotFoundException);
        await expect(construir().service.detail('t1', 'owner', 'no-es-un-id')).rejects.toBeInstanceOf(NotFoundException);
    });
});
