process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test';
import { SkuUnicoService, RESTRICCION_SKU_NO_VACIO } from './sku-unico.service';

/**
 * La regla «SKU no vacío» solo se crea cuando ya no queda ningún producto sin SKU: con la regla activa, actualizar un
 * producto sin SKU (su stock, por ejemplo) se rechazaría.
 */
function servicio(sinSku: { id: string; name: string }[], yaExiste = false) {
    const consultas: string[] = [];
    const dataSource: any = {
        query: jest.fn(async (sql: string) => {
            consultas.push(sql);
            if (sql.includes('btrim("sku") = \'\'')) return sinSku;
            if (sql.includes('pg_constraint')) return yaExiste ? [{ '?column?': 1 }] : [];
            return [];
        }),
    };
    return { svc: new SkuUnicoService(dataSource), consultas };
}

describe('SkuUnicoService.aplicarNoVacio', () => {
    it('con productos sin SKU no crea la regla y los nombra', async () => {
        const { svc, consultas } = servicio([{ id: 'p1', name: 'Sábanas' }]);
        const r = await svc.aplicarNoVacio();
        expect(r).toEqual({ aplicado: false, sinSku: [{ id: 'p1', name: 'Sábanas' }] });
        expect(consultas.some((c) => c.includes('ADD CONSTRAINT'))).toBe(false);
    });

    it('sin productos sin SKU crea la regla', async () => {
        const { svc, consultas } = servicio([]);
        expect(await svc.aplicarNoVacio()).toEqual({ aplicado: true, sinSku: [] });
        expect(consultas.some((c) => c.includes('ADD CONSTRAINT') && c.includes(RESTRICCION_SKU_NO_VACIO))).toBe(true);
    });

    it('si la regla ya existe no la vuelve a crear', async () => {
        const { svc, consultas } = servicio([], true);
        await svc.aplicarNoVacio();
        expect(consultas.some((c) => c.includes('ADD CONSTRAINT'))).toBe(false);
    });
});
