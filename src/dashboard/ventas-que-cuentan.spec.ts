import { DashboardInsightsService } from './dashboard-insights.service';
import { DashboardService } from './dashboard.service';

/** Un constructor de consultas falso que recuerda las condiciones que se le ponen. */
function consulta() {
    const condiciones: { sql: string; params: any }[] = [];
    const qb: any = {
        select: jest.fn(() => qb), addSelect: jest.fn(() => qb), where: jest.fn(() => qb), groupBy: jest.fn(() => qb),
        andWhere: jest.fn((sql: string, params: any) => { condiciones.push({ sql, params }); return qb; }),
        getRawOne: jest.fn(async () => ({ importe: '100', pedidos: '2' })),
    };
    return { qb, condiciones };
}

describe('las ventas canceladas y devueltas no cuentan para el cobro ni para los totales', () => {
    it('la base de la comisión de una tienda deja fuera cancelado y devuelto', async () => {
        const { qb, condiciones } = consulta();
        const servicio: any = Object.create(DashboardInsightsService.prototype);
        servicio.orders = { createQueryBuilder: () => qb };
        const importe = await servicio.ventasDeLaTienda('t1', new Date('2026-10-01'), new Date('2026-11-01'));
        expect(importe).toBe(100);
        const filtro = condiciones.find(c => c.sql.includes('saleState'));
        expect(filtro?.sql).toContain('NOT IN');
        expect(filtro?.params.fuera).toEqual(['cancelado', 'devuelto']);
    });

    it('los pedidos e importe del mes de una tienda también los dejan fuera', async () => {
        const { qb, condiciones } = consulta();
        const servicio: any = Object.create(DashboardService.prototype);
        servicio.orders = { createQueryBuilder: () => qb };
        await servicio.sumarVentas('t1', new Date('2026-10-01'));
        expect(condiciones.find(c => c.sql.includes('saleState'))?.params.fuera).toEqual(['cancelado', 'devuelto']);
    });
});
