import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrdersQueryService } from './orders-query.service';
import { permisosDeRol } from '../stores/permissions';

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
        getMany: jest.fn(async () => ordenes),
        getOne: jest.fn(async () => ordenes[0] ?? null),
        clone: jest.fn(() => qb), select: jest.fn(() => qb), groupBy: jest.fn(() => qb),
        getRawMany: jest.fn(async () => [{ estado: 'pendiente', n: '3' }, { estado: 'enviado', n: '2' }]),
    };
    const repoOrdenes = { createQueryBuilder: jest.fn(() => qb) };
    const repoProductos = {
        find: jest.fn(async () => [{ id: 'p1', sku: 'GAF-01', name: 'Gafas de sol', stock: 4, images: [{ url: 'https://img/gafas.jpg' }] }]),
    };
    const repoEnlaces = { find: jest.fn(async (): Promise<any[]> => []) };
    const service = new OrdersQueryService(repoOrdenes as any, repoProductos as any, repoEnlaces as any);
    return { service, qb, llamadas, repoProductos, repoEnlaces };
}

describe('variante guardada como JSON de Falabella', () => {
    it('una venta guardada con el JSON crudo se muestra limpia', async () => {
        const { service } = construir([{ ...ORDEN, items: [{ sku: 'SIN-CATALOGO', title: 'Banco', quantity: 1, unitPrice: 25, variant: '{"color":{"name":"Naranja","code":"#FF8800"}}' }] }]);
        const r = await service.list('t1', 'owner', {});
        expect(r.items[0].lines[0].variant).toBe('Color: Naranja');
    });
});

describe('descarga de las ventas filtradas', () => {
    it('da una fila por producto vendido, con el envío solo en la primera, y aplica los mismos filtros', async () => {
        const { service, llamadas } = construir([{ ...ORDEN, saleState: 'enviado', shippingPaid: 12, shippingType: 'comprador', shippingSellerCost: null, discountAmount: 5, details: { ...ORDEN.details, shippingAmount: 12 } }]);
        const r = await service.exportar('t1', 'owner', { status: 'enviado', marketplace: 'falabella', search: 'gafas' });
        expect(r).toMatchObject({ ventas: 1, incompleto: false });
        expect(r.filas).toHaveLength(2);
        expect(r.filas[0]).toMatchObject({ canal: 'falabella', numero_pedido: '7001', estado: 'enviado', cliente: 'Lucía Paredes', telefono: '999', sku: 'GAF-01', producto: 'Gafas de sol', cantidad: 1, precio_unitario: 149.9, envio_cobrado: 12, total_del_pedido: 171.9, numero_de_paquete: '', fecha: '2026-10-09', tipo_de_envio: 'comprador', costo_envio_para_el_vendedor: '', cupon_o_descuento: 5 });
        expect(r.filas[1]).toMatchObject({ sku: 'SIN-CATALOGO', envio_cobrado: 0, total_del_pedido: 0 });
        expect(llamadas.where.some(w => w.includes('saleState" IN'))).toBe(true);
        expect(llamadas.where.some(w => w.includes('o.marketplace'))).toBe(true);
        expect(llamadas.where.some(w => w.includes('ILIKE'))).toBe(true);
    });

    it('el día de la venta y el de enviar antes de son los de Lima, no los de hora universal', async () => {
        // 22:26 en Lima del 30 de octubre = 03:26 del 31 en hora universal.
        const { service } = construir([{ ...ORDEN, orderDate: new Date('2026-10-31T03:26:00Z'), shipByDate: new Date('2026-11-01T02:00:00Z') }]);
        const r = await service.exportar('t1', 'owner', {});
        expect(r.filas[0]).toMatchObject({ fecha: '2026-10-30', enviar_antes_de: '2026-10-31' });
    });

    it('quien solo tiene lectura no recibe teléfono, documento ni dirección', async () => {
        const { service } = construir();
        const r = await service.exportar('t1', 'viewer', {});
        expect(r.filas[0]).toMatchObject({ telefono: '', documento: '', direccion: '' });
        expect(r.filas[0].cliente).toBe('Lucía Paredes');
    });

    it('avisa si hay más ventas que el tope de la descarga', async () => {
        const muchas = Array.from({ length: 5001 }, (_, i) => ({ ...ORDEN, id: String(i) }));
        const { service } = construir(muchas);
        const r = await service.exportar('t1', 'owner', {});
        expect(r.incompleto).toBe(true);
        expect(r.ventas).toBe(5000);
    });
});

describe('variante de cada línea', () => {
    it('muestra la variante del catálogo para cada SKU, aunque el canal use el mismo nombre para todas', async () => {
        const { service, repoProductos } = construir([{ ...ORDEN, items: [
            { sku: 'GAF-01', title: 'Protector', quantity: 1, unitPrice: 10 },
            { sku: 'GAF-02', title: 'Protector', quantity: 1, unitPrice: 20, variant: 'Talla: King' },
            { sku: 'GAF-03', title: 'Protector', quantity: 1, unitPrice: 30 },
        ] }]);
        (repoProductos.find as any).mockResolvedValue([
            { id: 'p1', sku: 'GAF-01', name: 'Protector', stock: 4, images: [], variantValues: { Talla: 'Queen' } },
            { id: 'p2', sku: 'GAF-02', name: 'Protector', stock: 4, images: [], variantValues: { Talla: 'Doble' } },
        ]);
        const r = await service.list('t1', 'owner', {});
        // El catálogo manda; sin catálogo se usa lo que dijo el canal; sin ninguno, nada.
        expect(r.items[0].lines.map(l => l.variant)).toEqual(['Talla: Queen', 'Talla: Doble', null]);
    });
});

describe('filtro por estado de la venta', () => {
    it('sin estado trae todas; con estados filtra solo por los que existen', async () => {
        const todos = construir();
        await todos.service.list('t1', 'owner', {});
        expect(todos.llamadas.where.some(w => w.includes('saleState" IN'))).toBe(false);

        const filtrado = construir();
        await filtrado.service.list('t1', 'owner', { status: 'entregado, enviado,inventado' });
        const i = filtrado.llamadas.where.findIndex(w => w.includes('saleState" IN'));
        expect(filtrado.llamadas.params[i]).toEqual({ estados: ['enviado', 'entregado'] });
    });

    it('devuelve cuántas ventas hay en cada estado (con los demás filtros) y el estado de cada venta', async () => {
        const { service } = construir([{ ...ORDEN, saleState: 'enviado' }]);
        const r = await service.list('t1', 'owner', {});
        expect(r.porEstado).toEqual({ pendiente: 3, enviado: 2, entregado: 0, cancelado: 0, devuelto: 0 });
        expect(r.items[0].saleState).toBe('enviado');
    });
});

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

describe('ventas manuales en la consulta', () => {
    const manual = { ...ORDEN, marketplace: 'ripley', saleState: 'enviado', orderNumber: 'R-1', details: { ...ORDEN.details, manual: true, shippingAmount: 12, notes: 'regalo' } };

    it('se marcan como manuales y quien es dueño recibe lo necesario para editarlas', async () => {
        const { service } = construir([manual]);
        const lista = await service.list('t1', 'owner', {});
        expect(lista.items[0].manual).toBe(true);
        const d: any = await service.detail('t1', 'owner', ORDEN.id);
        expect(d.manualEdit).toMatchObject({ canal: 'ripley', fecha: '2026-10-09', numeroPedido: 'R-1', estado: 'enviado', envio: 12, cliente: 'Lucía Paredes', telefono: '999', notas: 'regalo' });
        expect(d.manualEdit.lineas[0]).toMatchObject({ sku: 'GAF-01', cantidad: 1, precio: 149.9, descontar: true });
        expect(d.manualEdit.lineas[1]).toMatchObject({ sku: 'SIN-CATALOGO', descontar: false });
    });

    it('quien solo lee no recibe los datos de edición, y una venta de un canal no es manual', async () => {
        const { service } = construir([manual]);
        const d: any = await service.detail('t1', 'viewer', ORDEN.id);
        expect(d.manualEdit).toBeUndefined();
        const normal = construir([ORDEN]);
        const lista = await normal.service.list('t1', 'owner', {});
        expect(lista.items[0].manual).toBe(false);
        const dn: any = await normal.service.detail('t1', 'owner', ORDEN.id);
        expect(dn.manualEdit).toBeUndefined();
    });
});

describe('«costos.ver»: quien no lo tiene no ve envío ni cupones', () => {
    const CON_COSTOS = { ...ORDEN, shippingPaid: '12.5', shippingSellerCost: '8', shippingType: 'gratis', discountAmount: '5', discountSellerFunded: '3' };
    const sinCostos = { role: 'viewer' as const, permissions: permisosDeRol('viewer').filter((p) => p !== 'costos.ver') };
    const conCostos = { role: 'viewer' as const, permissions: permisosDeRol('viewer') };

    it('con el permiso, la venta trae el envío cobrado, lo que cuesta al vendedor y el cupón', async () => {
        const { service } = construir([CON_COSTOS]);
        const [v] = (await service.list('t1', conCostos, {})).items;
        expect(v).toMatchObject({ costsHidden: false, shippingPaid: 12.5, shippingSellerCost: 8, shippingType: 'gratis', discountAmount: 5, discountSellerFunded: 3 });
    });

    it('sin el permiso, esos campos vienen vacíos y la venta avisa que están ocultos (el total y los productos siguen)', async () => {
        const { service } = construir([CON_COSTOS]);
        const [v] = (await service.list('t1', sinCostos, {})).items;
        expect(v).toMatchObject({ costsHidden: true, shippingPaid: 0, shippingSellerCost: null, shippingType: 'sin_dato', discountAmount: 0, discountSellerFunded: null, totalAmount: 149.9 });
        expect(v.lines.length).toBe(2);
        expect(JSON.stringify(v)).not.toContain('12.5');
    });

    it('tampoco se ve el envío de cada línea de producto', async () => {
        const conEnvioPorLinea = { ...CON_COSTOS, items: [{ sku: 'GAF-01', title: 'Gafas', quantity: 1, unitPrice: 149.9, shippingAmount: 9.5, shippingType: 'gratis' }] };
        const oculto = (await construir([conEnvioPorLinea]).service.list('t1', sinCostos, {})).items[0].lines[0];
        expect(oculto).toMatchObject({ shippingAmount: null, shippingType: null });
        const visible = (await construir([conEnvioPorLinea]).service.list('t1', conCostos, {})).items[0].lines[0];
        expect(visible).toMatchObject({ shippingAmount: 9.5, shippingType: 'gratis' });
    });

    it('el detalle de una venta también los oculta', async () => {
        const { service } = construir([CON_COSTOS]);
        const d: any = await service.detail('t1', sinCostos, ORDEN.id);
        expect(d).toMatchObject({ costsHidden: true, shippingSellerCost: null, discountAmount: 0 });
    });

    it('el Excel de quien no lo tiene no trae las columnas de envío ni cupones, y el total es solo lo vendido', async () => {
        const { service } = construir([CON_COSTOS]);
        const { filas } = await service.exportar('t1', sinCostos, {});
        for (const col of ['envio_cobrado', 'tipo_de_envio', 'costo_envio_para_el_vendedor', 'cupon_o_descuento']) expect(filas[0]).not.toHaveProperty(col);
        expect(filas[0].total_del_pedido).toBe(159.9); // 149.9 + 10 de los productos, sin los 12.5 de envío
    });

    it('el Excel de quien sí lo tiene sigue trayéndolas', async () => {
        const { service } = construir([CON_COSTOS]);
        const { filas } = await service.exportar('t1', conCostos, {});
        expect(filas[0]).toMatchObject({ envio_cobrado: 12.5, tipo_de_envio: 'gratis', costo_envio_para_el_vendedor: 8, cupon_o_descuento: 5, total_del_pedido: 172.4 });
    });

    it('quien solo se identifica con el nombre de su rol de fábrica sigue viendo costos (lector, editor y dueño los tienen)', async () => {
        const { service } = construir([CON_COSTOS]);
        for (const rol of ['viewer', 'editor', 'owner'] as const) {
            const [v] = (await service.list('t1', rol, {})).items;
            expect(v.costsHidden).toBe(false);
        }
    });
});
