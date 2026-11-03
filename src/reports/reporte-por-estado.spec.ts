import { ReportsService } from './reports.service';

/** Un constructor de consultas falso que recuerda las condiciones que se le ponen. */
function construir(conSheet = false) {
    const condiciones: { sql: string; params: any }[] = [];
    const selects: string[] = [];
    const qb: any = {
        select: jest.fn((e: string) => { selects.push(e); return qb; }), addSelect: jest.fn((e: string) => { selects.push(e); return qb; }), leftJoin: jest.fn(() => qb),
        where: jest.fn(() => qb), groupBy: jest.fn(() => qb), addGroupBy: jest.fn(() => qb), orderBy: jest.fn(() => qb),
        andWhere: jest.fn((sql: string, params: any) => { condiciones.push({ sql, params }); return qb; }),
        getRawMany: jest.fn(async () => [{ estado: 'enviado', orders: '2', sales: '100.5' }]),
        getRawOne: jest.fn(async () => ({ last: null })),
    };
    const repoOrdenes = { createQueryBuilder: jest.fn(() => qb) };
    const service = new ReportsService(repoOrdenes as any, {} as any, {} as any, {} as any);
    (service as any).legacyProfile = jest.fn(async () => (conSheet ? { sheetCsvUrl: 'http://sheet' } : null));
    (service as any).fetchSheetRows = jest.fn(async () => [{ date: '2026-10-05', channel: null, sales: 10, orders: 1 }]);
    return { service, condiciones, selects, hoja: (service as any).fetchSheetRows };
}

describe('reporte de ventas por estado', () => {
    it('sin estado elegido cuentan las ventas concretadas: se dejan fuera las canceladas y las devueltas', async () => {
        const { service, condiciones } = construir();
        const r = await service.getSalesReport('t1', '2026-10-01', '2026-10-31');
        const filtros = condiciones.filter(c => c.sql.includes('saleState'));
        expect(filtros.length).toBeGreaterThanOrEqual(2);
        expect(filtros[0].sql).toContain('NOT IN');
        expect(filtros[0].params.fuera).toEqual(['cancelado', 'devuelto']);
        expect(r.statusFilter).toEqual([]);
    });

    it('con estados filtra las ventas, y cuenta cuántas hay en cada estado', async () => {
        const { service, condiciones } = construir();
        const r = await service.getSalesReport('t1', '2026-10-01', '2026-10-31', 'entregado,enviado,otro');
        const filtros = condiciones.filter(c => c.sql.includes('saleState'));
        expect(filtros.length).toBeGreaterThanOrEqual(2); // por día/canal y por cuenta
        expect(filtros[0].sql).toContain('"saleState" IN (:...estados)');
        expect(filtros[0].params.estados).toEqual(['enviado', 'entregado']);
        expect(r.statusFilter).toEqual(['enviado', 'entregado']);
        expect(r.byStatus.find(e => e.status === 'enviado')).toEqual({ status: 'enviado', orders: 2, sales: 100.5 });
        expect(r.byStatus.map(e => e.status)).toEqual(['pendiente', 'enviado', 'entregado', 'cancelado', 'devuelto']);
    });

    it('con un estado elegido no se mezcla el Google Sheet, que no tiene estado', async () => {
        const todos = construir(true);
        await todos.service.getSalesReport('t1', '2026-10-01', '2026-10-31');
        expect(todos.hoja).toHaveBeenCalled();
        const filtrado = construir(true);
        await filtrado.service.getSalesReport('t1', '2026-10-01', '2026-10-31', 'entregado');
        expect(filtrado.hoja).not.toHaveBeenCalled();
    });
});

describe('envío, cupones y mapa de calor en el reporte', () => {
    it('por defecto las ventas son todo lo que pagó el cliente: productos más envío; sin el interruptor, solo productos', async () => {
        const conEnvio = construir();
        await conEnvio.service.getSalesReport('t1', '2026-10-01', '2026-10-31');
        expect(conEnvio.selects.some(s => s.includes('shippingPaid') && s.startsWith('SUM('))).toBe(true);

        const sinEnvio = construir();
        const r = await sinEnvio.service.getSalesReport('t1', '2026-10-01', '2026-10-31', undefined, false);
        expect(sinEnvio.selects.some(s => s.startsWith('SUM(') && s.includes('shippingPaid'))).toBe(false);
        expect(r.includeShipping).toBe(false);
    });

    it('el día de cada venta es el de Lima, no el de la base de datos', async () => {
        const { service, condiciones, selects } = construir();
        await service.getSalesReport('t1', '2026-10-01', '2026-10-31');
        expect(condiciones.some(c => c.sql.includes("AT TIME ZONE 'America/Lima'"))).toBe(true);
        expect(selects.some(s => s.includes("AT TIME ZONE 'America/Lima'"))).toBe(true);
    });

    it('devuelve los cuatro tipos de envío, los cupones y el mapa de calor, aunque no haya datos', async () => {
        const { service } = construir();
        const r = await service.getSalesReport('t1', '2026-10-01', '2026-10-31');
        expect(r.shipping.byType.map(t => t.type)).toEqual(['comprador', 'gratis', 'retiro', 'sin_dato']);
        expect(r.discounts).toMatchObject({ orders: expect.any(Number), amount: expect.any(Number) });
        expect(Array.isArray(r.heatmap)).toBe(true);
        expect(Number.isFinite(r.shipping.paidTotal)).toBe(true);
    });
});

describe('reporte de ventas sin «costos.ver»', () => {
    it('con el permiso trae el envío y los cupones, y por defecto las ventas incluyen lo que el cliente pagó por el envío', async () => {
        const { service } = construir();
        const r: any = await service.getSalesReport('t1', '2026-10-01', '2026-10-31');
        expect(r.costsHidden).toBe(false);
        expect(r.includeShipping).toBe(true);
        expect(r.shipping.byType.length).toBeGreaterThan(0);
    });

    it('sin el permiso, el envío y los cupones vienen vacíos y las ventas NO suman el envío, aunque se pida', async () => {
        const { service, selects } = construir();
        const r: any = await service.getSalesReport('t1', '2026-10-01', '2026-10-31', undefined, true, false);
        expect(r.costsHidden).toBe(true);
        expect(r.includeShipping).toBe(false);
        expect(r.shipping).toEqual({ paidTotal: 0, byType: [], byChannel: [] });
        expect(r.discounts).toEqual({ orders: 0, amount: 0, sellerFunded: 0, ordersWithKnownFunding: 0, byChannel: [] });
        // las ventas se calculan solo con los productos: nunca con «productsAmount + shippingPaid»
        expect(selects.join(' ')).not.toContain('"o"."productsAmount" + "o"."shippingPaid"');
    });
});
