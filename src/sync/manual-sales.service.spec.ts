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

    it('un producto que no está en el catálogo se registra con su nombre y sin tocar stock', async () => {
        const { servicio, ordenes } = construir({ productos: [] });
        const r = await servicio.registrar(scope, venta([{ canal: 'WhatsApp', producto: 'Cosa suelta', precio_unitario: 20 }]));
        expect(r.registradas).toBe(1);
        expect(ordenes[0].items[0]).toMatchObject({ sku: null, title: 'Cosa suelta', productId: null });
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
