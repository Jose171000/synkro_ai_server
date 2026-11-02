import { ReportsService } from './reports.service';

/** Un constructor de consultas falso que recuerda las condiciones que se le ponen. */
function construir(conSheet = false) {
    const condiciones: { sql: string; params: any }[] = [];
    const qb: any = {
        select: jest.fn(() => qb), addSelect: jest.fn(() => qb), leftJoin: jest.fn(() => qb),
        where: jest.fn(() => qb), groupBy: jest.fn(() => qb), addGroupBy: jest.fn(() => qb), orderBy: jest.fn(() => qb),
        andWhere: jest.fn((sql: string, params: any) => { condiciones.push({ sql, params }); return qb; }),
        getRawMany: jest.fn(async () => [{ estado: 'enviado', orders: '2', sales: '100.5' }]),
        getRawOne: jest.fn(async () => ({ last: null })),
    };
    const repoOrdenes = { createQueryBuilder: jest.fn(() => qb) };
    const service = new ReportsService(repoOrdenes as any, {} as any, {} as any, {} as any);
    (service as any).legacyProfile = jest.fn(async () => (conSheet ? { sheetCsvUrl: 'http://sheet' } : null));
    (service as any).fetchSheetRows = jest.fn(async () => [{ date: '2026-10-05', channel: null, sales: 10, orders: 1 }]);
    return { service, condiciones, hoja: (service as any).fetchSheetRows };
}

describe('reporte de ventas por estado', () => {
    it('sin estado no filtra', async () => {
        const { service, condiciones } = construir();
        const r = await service.getSalesReport('t1', '2026-10-01', '2026-10-31');
        expect(condiciones.some(c => c.sql.includes('saleState'))).toBe(false);
        expect(r.statusFilter).toEqual([]);
    });

    it('con estados filtra las ventas, y cuenta cuántas hay en cada estado', async () => {
        const { service, condiciones } = construir();
        const r = await service.getSalesReport('t1', '2026-10-01', '2026-10-31', 'entregado,enviado,otro');
        const filtros = condiciones.filter(c => c.sql.includes('saleState'));
        expect(filtros.length).toBeGreaterThanOrEqual(2); // por día/canal y por cuenta
        expect(filtros[0].params).toEqual({ estados: ['enviado', 'entregado'] });
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
