import { calcularDescuento, partirEnTramos, tramoDelDia, tramoSiguiente } from './descuento-general';

const HOY = '2026-11-14';

describe('calcularDescuento', () => {
    it('en porcentaje calcula el precio y lo redondea a céntimos', () => {
        const r = calcularDescuento(265, { modo: 'porcentaje', valor: 15, hasta: '2027-01-31' }, HOY);
        expect(r).toEqual({ salePrice: 225.25, porcentaje: 15, desde: HOY, hasta: '2027-01-31' });
    });

    it('en soles guarda el precio y dice qué porcentaje es', () => {
        const r = calcularDescuento(265, { modo: 'precio', valor: 199, desde: '2026-12-01', hasta: '2027-01-31' }, HOY);
        expect(r.salePrice).toBe(199);
        expect(r.porcentaje).toBe(24.9);
        expect(r.desde).toBe('2026-12-01');
    });

    it('la fecha de fin es obligatoria', () => {
        expect(() => calcularDescuento(265, { modo: 'porcentaje', valor: 10 }, HOY)).toThrow('fecha de fin');
        expect(() => calcularDescuento(265, { modo: 'porcentaje', valor: 10, hasta: '  ' }, HOY)).toThrow('fecha de fin');
    });

    it('rechaza fechas inválidas, invertidas o ya pasadas', () => {
        expect(() => calcularDescuento(265, { modo: 'porcentaje', valor: 10, hasta: '2027-02-30' }, HOY)).toThrow('no es válida');
        expect(() => calcularDescuento(265, { modo: 'porcentaje', valor: 10, desde: '2027-02-01', hasta: '2027-01-01' }, HOY)).toThrow('anterior');
        expect(() => calcularDescuento(265, { modo: 'porcentaje', valor: 10, hasta: '2026-11-01' }, HOY)).toThrow('ya pasó');
    });

    it('rechaza valores que no rebajan el precio', () => {
        expect(() => calcularDescuento(265, { modo: 'precio', valor: 265, hasta: '2027-01-31' }, HOY)).toThrow('menor que el precio regular');
        expect(() => calcularDescuento(265, { modo: 'precio', valor: 300, hasta: '2027-01-31' }, HOY)).toThrow('menor que el precio regular');
        expect(() => calcularDescuento(265, { modo: 'porcentaje', valor: 100, hasta: '2027-01-31' }, HOY)).toThrow('menor que 100');
        expect(() => calcularDescuento(265, { modo: 'porcentaje', valor: 0, hasta: '2027-01-31' }, HOY)).toThrow('mayor que 0');
        expect(() => calcularDescuento(0, { modo: 'porcentaje', valor: 10, hasta: '2027-01-31' }, HOY)).toThrow('precio regular');
    });
});

describe('partirEnTramos', () => {
    it('un descuento corto cabe en un solo tramo', () => {
        expect(partirEnTramos('2026-11-14', '2026-11-20', 30)).toEqual([{ desde: '2026-11-14', hasta: '2026-11-20' }]);
    });

    it('un año se parte en tramos consecutivos sin huecos ni solapes', () => {
        const t = partirEnTramos('2026-11-14', '2027-11-13', 30);
        expect(t[0]).toEqual({ desde: '2026-11-14', hasta: '2026-12-13' });
        expect(t[1].desde).toBe('2026-12-14');
        expect(t[t.length - 1].hasta).toBe('2027-11-13');
        expect(t).toHaveLength(13); // 365 días / 30
        for (let i = 1; i < t.length; i++) {
            expect(Date.parse(t[i].desde) - Date.parse(t[i - 1].hasta)).toBe(24 * 3600 * 1000);
        }
    });

    it('el último tramo puede ser más corto y un día suelto es válido', () => {
        expect(partirEnTramos('2026-11-01', '2026-11-31'.replace('31', '30'), 14)).toEqual([
            { desde: '2026-11-01', hasta: '2026-11-14' },
            { desde: '2026-11-15', hasta: '2026-11-28' },
            { desde: '2026-11-29', hasta: '2026-11-30' },
        ]);
        expect(partirEnTramos('2026-11-14', '2026-11-14', 14)).toEqual([{ desde: '2026-11-14', hasta: '2026-11-14' }]);
    });

    it('fechas inválidas no dan tramos', () => {
        expect(partirEnTramos('2026-11-14', '2026-11-01', 30)).toEqual([]);
        expect(partirEnTramos('x', '2026-11-01', 30)).toEqual([]);
    });
});

describe('tramoDelDia y tramoSiguiente', () => {
    const t = partirEnTramos('2026-11-14', '2027-01-31', 30);
    it('encuentra el tramo de un día y el siguiente', () => {
        expect(tramoDelDia(t, '2026-12-20')).toEqual(t[1]);
        expect(tramoSiguiente(t, t[0])).toEqual(t[1]);
        expect(tramoSiguiente(t, t[t.length - 1])).toBeNull();
    });
    it('fuera del periodo no hay tramo', () => {
        expect(tramoDelDia(t, '2026-11-13')).toBeNull();
        expect(tramoDelDia(t, '2027-02-01')).toBeNull();
    });
});
