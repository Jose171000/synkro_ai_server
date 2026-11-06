import ExcelJS = require('exceljs');
import { ReportsService } from './reports.service';
import { reporteAExcel, reporteAPdf, DatosDelReporte } from './reports-export';
import { hoyEnLima } from '../admin/plan-comercial';

/** El día de hoy en Lima, y días atrás, como AAAA-MM-DD (igual que lo que arma el servicio). */
const hoy = hoyEnLima();
const hace = (n: number) => new Date(new Date(`${hoy}T12:00:00Z`).getTime() - n * 86_400_000).toISOString().slice(0, 10);

const producto = (id: string, sku: string, name: string, stock: number, over: any = {}) => ({ id, sku, name, stock, variantValues: null, images: [], ...over });

function armarServicio(opts: { periodo: any[]; ritmo: any[]; productos: any[]; enlaces?: any[] }) {
    const consultas: any[] = [];
    const qbOrdenes = (filas: any[]) => {
        const qb: any = { select: () => qb, addSelect: () => qb, where: () => qb, andWhere: (sql: string, p: any) => { consultas.push({ sql, p }); return qb; }, getRawMany: async () => filas };
        return qb;
    };
    let n = 0;
    const repoOrdenes = { createQueryBuilder: jest.fn(() => qbOrdenes(n++ === 0 ? opts.periodo : opts.ritmo)) };
    const qbProd: any = { leftJoinAndSelect: () => qbProd, where: () => qbProd, andWhere: () => qbProd, getMany: async () => opts.productos };
    const repoProductos = { createQueryBuilder: jest.fn(() => qbProd) };
    const repoEnlaces = { find: jest.fn(async () => opts.enlaces ?? []) };
    const service = new ReportsService(repoOrdenes as any, {} as any, {} as any, {} as any, repoProductos as any, repoEnlaces as any);
    return { service, consultas };
}

const venta = (id: string, fecha: string, items: any[]) => ({ id, fecha, items });

describe('productos ganadores', () => {
    const silla = producto('p1', '107-001-116', 'Silla de ruedas', 6);
    const lonchera = producto('p2', 'LCH-1', 'Lonchera', 90, { variantValues: { Color: 'Rosada' }, images: [{ url: 'https://img/l.jpg' }] });

    it('suma unidades e ingresos por producto, estima cuándo se agota y ordena', async () => {
        const periodo = [
            venta('v1', hace(3), [{ sku: '107-001-116', productId: 'p1', quantity: 2, unitPrice: 550 }]),
            venta('v2', hace(2), [{ sku: '107-001-116', productId: 'p1', quantity: 1, unitPrice: 550 }, { sku: 'LCH-1', productId: 'p2', quantity: 5, unitPrice: 40 }]),
        ];
        // En los últimos 30 días la silla vendió 30 unidades (1 por día) y la lonchera 3.
        const ritmo = [venta('r1', hace(29), [{ sku: '107-001-116', productId: 'p1', quantity: 30, unitPrice: 550 }, { sku: 'LCH-1', productId: 'p2', quantity: 3, unitPrice: 40 }])];
        const { service } = armarServicio({ periodo, ritmo, productos: [silla, lonchera] });

        const r = await service.getTopProducts('t1', hace(5), hoy);

        expect(r.totals).toEqual({ units: 8, revenue: 1850, products: 2 });
        expect(r.items.map((i) => i.sku)).toEqual(['LCH-1', '107-001-116']); // por unidades: 5 y 3
        const s = r.items.find((i) => i.sku === '107-001-116')!;
        expect(s).toMatchObject({ units: 3, revenue: 1650, stock: 6, share: 89.2 });
        expect(s.estimate).toMatchObject({ estado: 'critico', porDia: 1, dias: 6, recomendacion: 'Repón ya', sugerido: 24 });
        const l = r.items.find((i) => i.sku === 'LCH-1')!;
        expect(l).toMatchObject({ name: 'Lonchera', variant: 'Rosada', imageUrl: 'https://img/l.jpg' });
        expect(l.estimate.estado).toBe('suficiente');
    });

    it('ordena por ingresos o por el que se agota antes', async () => {
        const periodo = [venta('v1', hace(1), [{ productId: 'p1', quantity: 1, unitPrice: 550 }, { productId: 'p2', quantity: 9, unitPrice: 40 }])];
        const ritmo = [venta('r1', hace(29), [{ productId: 'p1', quantity: 30, unitPrice: 1 }, { productId: 'p2', quantity: 3, unitPrice: 1 }])];
        const { service } = armarServicio({ periodo, ritmo, productos: [silla, lonchera] });
        expect((await service.getTopProducts('t1', hace(5), hoy, undefined, 'revenue')).items[0].sku).toBe('107-001-116');

        const otra = armarServicio({ periodo, ritmo, productos: [silla, lonchera] });
        expect((await otra.service.getTopProducts('t1', hace(5), hoy, undefined, 'days')).items[0].sku).toBe('107-001-116'); // 6 días contra 900
    });

    it('lo vendido que ya no está en el catálogo sale con el nombre de la venta, sin stock ni estimación de stock', async () => {
        const periodo = [venta('v1', hace(1), [{ sku: 'VIEJO-1', title: 'Producto descatalogado', quantity: 2, unitPrice: 10 }])];
        const { service } = armarServicio({ periodo, ritmo: [], productos: [] });
        const r = await service.getTopProducts('t1', hace(5), hoy);
        expect(r.items[0]).toMatchObject({ productId: null, sku: 'VIEJO-1', name: 'Producto descatalogado', stock: null });
        expect(r.items[0].estimate.estado).toBe('agotado');
    });

    it('un producto sin foto usa la de su publicación en un canal', async () => {
        const periodo = [venta('v1', hace(1), [{ productId: 'p1', quantity: 1, unitPrice: 10 }])];
        const { service } = armarServicio({ periodo, ritmo: [], productos: [silla], enlaces: [{ product: { id: 'p1' }, imageUrl: 'https://img/canal.jpg' }] });
        expect((await service.getTopProducts('t1', hace(5), hoy)).items[0].imageUrl).toBe('https://img/canal.jpg');
    });

    it('sin ventas devuelve la lista vacía', async () => {
        const { service } = armarServicio({ periodo: [], ritmo: [], productos: [] });
        expect(await service.getTopProducts('t1', hace(5), hoy)).toMatchObject({ totals: { units: 0, revenue: 0, products: 0 }, items: [] });
    });
});

describe('reporte descargable', () => {
    const datos = (): DatosDelReporte => ({
        tienda: 'Corporación Médica',
        generado: new Date('2026-11-06T16:00:00Z'),
        estados: [],
        ventas: {
            range: { from: '2026-11-01', to: '2026-11-06' },
            totals: { sales: 14007, orders: 78, avgTicket: 179.58 },
            byDay: [{ date: '2026-11-01', sales: 2000, orders: 10 }, { date: '2026-11-02', sales: 5200, orders: 25 }, { date: '2026-11-03', sales: 3100, orders: 18 }],
            byChannel: [{ channel: 'falabella', sales: 9000, orders: 50 }, { channel: 'mercadolibre', sales: 5007, orders: 28 }],
            byAccount: [{ channel: 'falabella', label: 'Cuenta A', sales: 9000, orders: 50 }],
            includeShipping: false,
        },
        ganadores: {
            range: { from: '2026-11-01', to: '2026-11-06' }, sort: 'units', paceWindowDays: 30, totals: { units: 41, revenue: 22550, products: 2 },
            items: [
                { productId: 'p1', sku: '107-001-116', name: 'Silla de ruedas estándar plegable', variant: null, imageUrl: null, units: 41, revenue: 22550, orders: 30, share: 90.1, stock: 6,
                    estimate: { estado: 'critico', porDia: 1.4, dias: 4.3, agotaEl: '2026-11-10', sugerido: 36, recomendacion: 'Repón ya' } },
                { productId: 'p2', sku: 'X', name: 'Producto con ñ y acentos áéí', variant: 'Gris / Queen', imageUrl: null, units: 3, revenue: 300, orders: 3, share: 1.3, stock: 0,
                    estimate: { estado: 'agotado', porDia: 0.2, dias: null, agotaEl: null, sugerido: 6, recomendacion: 'Sin stock: repón ya' } },
            ],
        },
    });

    it('el Excel trae una hoja por bloque y los productos ganadores con su estado de stock', async () => {
        const buffer = await reporteAExcel(datos());
        const libro = new ExcelJS.Workbook();
        await libro.xlsx.load(buffer as any);
        expect(libro.worksheets.map((h) => h.name)).toEqual(['Resumen', 'Ventas por día', 'Canales y cuentas', 'Productos ganadores']);
        const g = libro.getWorksheet('Productos ganadores')!;
        expect(g.getRow(2).getCell(3).value).toBe('Silla de ruedas estándar plegable');
        expect(g.getRow(2).getCell(13).value).toBe('Crítico');
        expect(g.getRow(2).getCell(15).value).toBe(36);
        expect(g.getRow(3).getCell(13).value).toBe('Agotado');
        expect(libro.getWorksheet('Ventas por día')!.rowCount).toBe(4);
    });

    it('el PDF se genera completo, con varias secciones y acentos', async () => {
        const buffer = await reporteAPdf(datos());
        expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
        expect(buffer.length).toBeGreaterThan(3000);
    });

    it('el PDF y el Excel salen también sin ventas', async () => {
        const vacio = datos();
        vacio.ventas.byDay = []; vacio.ventas.byChannel = []; vacio.ganadores.items = [];
        expect((await reporteAPdf(vacio)).subarray(0, 5).toString()).toBe('%PDF-');
        expect((await reporteAExcel(vacio)).length).toBeGreaterThan(1000);
    });
});
