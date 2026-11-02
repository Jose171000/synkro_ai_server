import * as ExcelJS from 'exceljs';
import { ManualSalesService } from './manual-sales.service';
import { ventasDeFilas } from './ventas-manuales';

function construir(opts: { conectados?: string[]; productos?: any[] } = {}) {
    const ordenes: any[] = [];
    const trabajos: any[] = [];
    const producto = { id: 'p1', sku: 'SKU-1', name: 'Gafas', stock: 5 };
    const productos = opts.productos ?? [producto];
    const repoOrdenes: any = {
        create: (d: any) => ({ ...d }),
        save: jest.fn(async (o: any) => { o.id = `o${ordenes.length + 1}`; ordenes.push(o); return o; }),
        findOne: jest.fn(async ({ where }: any) => ordenes.find(o => o.marketplace === where.marketplace && o.externalId === where.externalId) ?? null),
        update: jest.fn(async (id: string, d: any) => { Object.assign(ordenes.find(o => o.id === id) ?? {}, d); }),
    };
    const repoConexiones: any = { find: jest.fn(async () => (opts.conectados ?? []).map(m => ({ marketplace: m }))) };
    const repoProductos: any = {
        find: jest.fn(async () => productos),
        findOne: jest.fn(async ({ where }: any) => productos.find(p => p.id === where.id) ?? null),
        save: jest.fn(async (p: any) => p),
    };
    const repoEnlaces: any = { find: jest.fn(async () => [{ marketplace: 'falabella', connection: { id: 'c9' } }]) };
    const cola: any = { add: jest.fn(async (n: string, d: any) => { trabajos.push({ n, d }); }) };
    const servicio = new ManualSalesService(repoOrdenes, repoConexiones, repoProductos, repoEnlaces, cola);
    return { servicio, ordenes, trabajos, producto };
}
const scope = { userId: 'u1', storeId: 't1' };
const venta = (filas: any[]) => ventasDeFilas(filas).ventas;

describe('registro de ventas de canales no conectados', () => {
    it('registra la venta en la tienda, con el envío aparte de la base de comisión, y baja el stock', async () => {
        const { servicio, ordenes, producto } = construir();
        const r = await servicio.registrar(scope, venta([{ numero_pedido: 'R-1', fecha: '2026-10-25', canal: 'Ripley', sku: 'SKU-1', cantidad: 2, precio_unitario: 50, envio: 10, cliente: 'Ana' }]));
        expect(r).toEqual({ registradas: 1, rechazadas: [] });
        expect(ordenes[0]).toMatchObject({
            marketplace: 'ripley', externalId: 'MAN-ripley-R-1', store: { id: 't1' }, owner: { id: 'u1' }, connection: null,
            productsAmount: 100, totalAmount: 110, saleState: 'entregado', customerName: 'Ana', orderNumber: 'R-1',
        });
        expect(ordenes[0].orderDate.toISOString()).toBe('2026-10-25T17:00:00.000Z');
        expect(ordenes[0].items[0]).toMatchObject({ sku: 'SKU-1', title: 'Gafas', quantity: 2, unitPrice: 50, stockBefore: 5, stockAfter: 3 });
        expect(producto.stock).toBe(3);
    });

    it('avisa del nuevo stock a los canales conectados donde está publicado el producto', async () => {
        const { servicio, trabajos } = construir();
        await servicio.registrar(scope, venta([{ canal: 'WhatsApp', sku: 'SKU-1', precio_unitario: 5 }]));
        expect(trabajos).toEqual([{ n: 'inventory', d: { productId: 'p1', userId: 'u1', marketplace: 'falabella', connectionId: 'c9' } }]);
    });

    it('con descontar_stock = NO, o si la venta está cancelada o devuelta, el stock no se toca', async () => {
        const { servicio, producto, trabajos } = construir();
        await servicio.registrar(scope, venta([{ canal: 'Ripley', sku: 'SKU-1', precio_unitario: 5, descontar_stock: 'NO' }]));
        await servicio.registrar(scope, venta([{ canal: 'Ripley', sku: 'SKU-1', precio_unitario: 5, estado: 'cancelado' }]));
        await servicio.registrar(scope, venta([{ canal: 'Ripley', sku: 'SKU-1', precio_unitario: 5, estado: 'devuelto' }]));
        expect(producto.stock).toBe(5);
        expect(trabajos).toHaveLength(0);
    });

    it('un SKU que no está en el catálogo se rechaza: el producto se identifica solo por su SKU', async () => {
        const { servicio, ordenes } = construir({ productos: [] });
        const r = await servicio.registrar(scope, venta([{ canal: 'WhatsApp', sku: 'NO-EXISTE', precio_unitario: 20 }]));
        expect(r.registradas).toBe(0);
        expect(r.rechazadas[0]).toContain('el SKU NO-EXISTE no está en el catálogo');
        expect(ordenes).toHaveLength(0);
    });

    it('sin precio escrito se usa el del catálogo, el SKU no distingue mayúsculas y la variante queda en la línea', async () => {
        const { servicio, ordenes } = construir({ productos: [{ id: 'p1', sku: 'ALM-01', name: 'Almohada', stock: 9, price: 79.9, variantValues: { Tamaño: 'King' } }] });
        const r = await servicio.registrar(scope, venta([{ canal: 'Ripley', sku: 'alm-01', cantidad: 2 }]));
        expect(r.registradas).toBe(1);
        expect(ordenes[0].items[0]).toMatchObject({ sku: 'ALM-01', title: 'Almohada', unitPrice: 79.9, variant: 'Tamaño: King' });
        expect(ordenes[0].productsAmount).toBe(159.8);
    });

    it('un producto sin precio en el catálogo pide escribir el precio', async () => {
        const { servicio } = construir({ productos: [{ id: 'p1', sku: 'ALM-01', name: 'Almohada', stock: 9, price: null }] });
        const r = await servicio.registrar(scope, venta([{ canal: 'Ripley', sku: 'ALM-01' }]));
        expect(r.registradas).toBe(0);
        expect(r.rechazadas[0]).toContain('no tiene precio en el catálogo');
    });

    it('el buscador encuentra por SKU o por nombre y devuelve lo necesario para elegir', async () => {
        const { servicio } = construir();
        const qb: any = { where: () => qb, andWhere: () => qb, orderBy: () => qb, addOrderBy: () => qb, setParameter: () => qb, take: () => qb,
            getMany: async () => [{ sku: 'ALM-01', name: 'Almohada', price: '79.90', stock: 9, variantValues: { Tamaño: 'King' }, images: [{ url: 'http://x/a.jpg' }] }] };
        (servicio as any).products.createQueryBuilder = () => qb;
        expect(await servicio.buscarProductos(scope, 'alm')).toEqual([{ sku: 'ALM-01', name: 'Almohada', variant: 'Tamaño: King', price: 79.9, stock: 9, imageUrl: 'http://x/a.jpg' }]);
        expect(await servicio.buscarProductos(scope, '  ')).toEqual([]);
    });

    it('el mismo número de pedido en el mismo canal no se registra dos veces', async () => {
        const { servicio, ordenes, producto } = construir();
        const filas = [{ numero_pedido: 'R-1', canal: 'Ripley', sku: 'SKU-1', precio_unitario: 5 }];
        await servicio.registrar(scope, venta(filas));
        const r = await servicio.registrar(scope, venta(filas));
        expect(r).toEqual({ registradas: 0, rechazadas: ['Pedido R-1: ya está registrado.'] });
        expect(ordenes).toHaveLength(1);
        expect(producto.stock).toBe(4);
    });

    it('una fecha futura se rechaza (no aparecería en las listas) y la de hoy en Lima sí se acepta', async () => {
        const { servicio, ordenes } = construir();
        const mañana = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
        const rechazada = await servicio.registrar(scope, venta([{ canal: 'Ripley', sku: 'SKU-1', precio_unitario: 5, fecha: mañana }]));
        expect(rechazada.registradas).toBe(0);
        expect(rechazada.rechazadas[0]).toContain('es futura');
        const hoyLima = new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);
        const aceptada = await servicio.registrar(scope, venta([{ canal: 'Ripley', sku: 'SKU-1', precio_unitario: 5, fecha: hoyLima }]));
        expect(aceptada.registradas).toBe(1);
        expect(ordenes).toHaveLength(1);
    });

    it('un canal que la tienda tiene conectado se rechaza: sus ventas entran solas', async () => {
        const { servicio, ordenes } = construir({ conectados: ['falabella'] });
        const r = await servicio.registrar(scope, venta([{ canal: 'Falabella', sku: 'SKU-1', precio_unitario: 5 }]));
        expect(r.registradas).toBe(0);
        expect(r.rechazadas[0]).toContain('Falabella está conectado');
        expect(ordenes).toHaveLength(0);
    });

    it('desde un Excel, una fila con problema no impide registrar las demás', async () => {
        const { servicio, ordenes } = construir();
        const libro = new ExcelJS.Workbook();
        const hoja = libro.addWorksheet('Ventas');
        hoja.addRow(['canal', 'sku', 'precio_unitario']);
        hoja.addRow(['Ripley', 'SKU-1', 10]);
        hoja.addRow(['Ripley', 'SKU-1', 'mucho']);
        const r = await servicio.importarExcel(scope, Buffer.from(await libro.xlsx.writeBuffer()));
        expect(r.registradas).toBe(1);
        expect(r.rechazadas).toHaveLength(1);
        expect(r.rechazadas[0]).toMatch(/^Fila 3:/);
        expect(ordenes).toHaveLength(1);
    });
});

describe('editar y eliminar ventas manuales', () => {
    const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
    const construirConId = () => {
        const base = construir();
        const repo: any = (base.servicio as any).orders;
        repo.save = jest.fn(async (o: any) => { o.id = uuid(base.ordenes.length + 1); base.ordenes.push(o); return o; });
        repo.findOne = jest.fn(async ({ where }: any) => base.ordenes.find((o: any) => (where.id ? o.id === where.id : o.marketplace === where.marketplace && o.externalId === where.externalId)) ?? null);
        repo.delete = jest.fn(async (id: string) => { const i = base.ordenes.findIndex((o: any) => o.id === id); if (i >= 0) base.ordenes.splice(i, 1); });
        return base;
    };
    const filas = (extra: any = {}) => [{ numero_pedido: 'R-1', fecha: '2026-10-25', canal: 'Ripley', sku: 'SKU-1', cantidad: 2, precio_unitario: 50, ...extra }];

    it('al editar se devuelve el stock anterior y se descuenta el nuevo, y la venta cambia de datos', async () => {
        const { servicio, ordenes, producto } = construirConId();
        await servicio.registrar(scope, venta(filas()));
        expect(producto.stock).toBe(3);

        await servicio.editar(scope, ordenes[0].id, filas({ cantidad: 1, precio_unitario: 80, cliente: 'Luis', estado: 'enviado' }));

        expect(producto.stock).toBe(4);
        expect(ordenes).toHaveLength(1);
        expect(ordenes[0]).toMatchObject({ productsAmount: 80, totalAmount: 80, customerName: 'Luis', saleState: 'enviado', externalId: 'MAN-ripley-R-1' });
        expect(ordenes[0].items[0]).toMatchObject({ quantity: 1, unitPrice: 80, stockBefore: 5, stockAfter: 4 });
    });

    it('pasar una venta a cancelada devuelve el stock y ya no lo descuenta', async () => {
        const { servicio, ordenes, producto } = construirConId();
        await servicio.registrar(scope, venta(filas()));
        await servicio.editar(scope, ordenes[0].id, filas({ estado: 'cancelado' }));
        expect(producto.stock).toBe(5);
        expect(ordenes[0].saleState).toBe('cancelado');
    });

    it('una edición con error no toca el stock ni la venta', async () => {
        const { servicio, ordenes, producto } = construirConId();
        await servicio.registrar(scope, venta(filas()));
        await expect(servicio.editar(scope, ordenes[0].id, filas({ sku: 'NO-EXISTE' }))).rejects.toThrow('no está en el catálogo');
        await expect(servicio.editar(scope, ordenes[0].id, filas({ precio_unitario: 'mucho' }))).rejects.toThrow('precio_unitario');
        expect(producto.stock).toBe(3);
        expect(ordenes[0].items[0]).toMatchObject({ sku: 'SKU-1', quantity: 2 });
    });

    it('cambiar el número a uno que ya existe en el canal se rechaza; el propio número no choca consigo mismo', async () => {
        const { servicio, ordenes } = construirConId();
        await servicio.registrar(scope, venta(filas()));
        await servicio.registrar(scope, venta(filas({ numero_pedido: 'R-2' })));
        await expect(servicio.editar(scope, ordenes[1].id, filas({ numero_pedido: 'R-1' }))).rejects.toThrow('ya está registrado');
        await expect(servicio.editar(scope, ordenes[1].id, filas({ numero_pedido: 'R-2', cliente: 'Ana' }))).resolves.toBeDefined();
    });

    it('solo se editan y eliminan las ventas manuales: una que trajo un canal se rechaza', async () => {
        const { servicio, ordenes } = construirConId();
        ordenes.push({ id: uuid(99), marketplace: 'falabella', externalId: '100', details: { shipping: {} }, items: [] });
        await expect(servicio.editar(scope, uuid(99), filas())).rejects.toThrow('Solo se pueden editar');
        await expect(servicio.eliminar(scope, uuid(99))).rejects.toThrow('Solo se pueden editar');
        await expect(servicio.eliminar(scope, 'no-es-un-id')).rejects.toThrow('Venta no encontrada');
        expect(ordenes).toHaveLength(1);
    });

    it('eliminar borra la venta y devuelve el stock que había descontado', async () => {
        const { servicio, ordenes, producto, trabajos } = construirConId();
        await servicio.registrar(scope, venta(filas()));
        expect(producto.stock).toBe(3);
        trabajos.length = 0;
        await expect(servicio.eliminar(scope, ordenes[0].id)).resolves.toEqual({ eliminada: true });
        expect(ordenes).toHaveLength(0);
        expect(producto.stock).toBe(5);
        expect(trabajos).toEqual([{ n: 'inventory', d: { productId: 'p1', userId: 'u1', marketplace: 'falabella', connectionId: 'c9' } }]);
    });

    it('una venta registrada sin descontar stock no devuelve nada al eliminarla', async () => {
        const { servicio, ordenes, producto } = construirConId();
        await servicio.registrar(scope, venta(filas({ descontar_stock: 'NO' })));
        await servicio.eliminar(scope, ordenes[0].id);
        expect(producto.stock).toBe(5);
    });
});
