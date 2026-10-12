import {
    avanzarVencimiento,
    comisionDelMes,
    diasEntre,
    estadoDePago,
    hoyEnLima,
    mensualizar,
    proponerPlan,
    sumarMeses,
} from './plan-comercial';

/**
 * Lo que se protege: los vencimientos no se corren por pagar tarde, un mes
 * corto no rompe la fecha, la comisión proyectada no se inventa en los
 * primeros días del mes, y la propuesta solo compara lo que está pactado.
 */

describe('fechas', () => {
    it('hoy se cuenta en Lima: a las 02:00 UTC todavía es el día anterior', () => {
        expect(hoyEnLima(new Date('2026-10-12T02:00:00Z'))).toBe('2026-10-11');
        expect(hoyEnLima(new Date('2026-10-12T05:00:00Z'))).toBe('2026-10-12');
    });

    it('sumar meses no se sale del mes', () => {
        expect(sumarMeses('2026-01-31', 1)).toBe('2026-02-28');
        expect(sumarMeses('2028-01-31', 1)).toBe('2028-02-29');
        expect(sumarMeses('2026-11-15', 3)).toBe('2027-02-15');
        expect(sumarMeses('2026-12-10', 1)).toBe('2027-01-10');
    });

    it('cuenta días entre fechas', () => {
        expect(diasEntre('2026-10-12', '2026-10-19')).toBe(7);
        expect(diasEntre('2026-10-12', '2026-10-10')).toBe(-2);
        expect(diasEntre('2026-10-12', '2026-10-12')).toBe(0);
    });
});

describe('estado del próximo pago', () => {
    const hoy = '2026-10-12';
    it.each([
        ['2026-10-10', 'vencido', -2],
        ['2026-10-12', 'vence_hoy', 0],
        ['2026-10-15', 'por_vencer', 3],
        ['2026-10-19', 'por_vencer', 7],
        ['2026-10-20', 'al_dia', 8],
    ])('%s → %s', (fecha, estado, dias) => {
        expect(estadoDePago(fecha, hoy)).toEqual({ estado, dias });
    });

    it('sin fecha no hay estado', () => {
        expect(estadoDePago(null, hoy)).toBeNull();
    });
});

describe('cuotas', () => {
    it('lleva cualquier frecuencia a su aporte mensual', () => {
        expect(mensualizar(300, 'mensual')).toBe(300);
        expect(mensualizar(900, 'trimestral')).toBe(300);
        expect(mensualizar(1200, 'anual')).toBe(100);
        expect(mensualizar(null, 'mensual')).toBe(0);
        expect(mensualizar(300, undefined)).toBe(300);
    });

    it('al registrar un pago, el vencimiento avanza un periodo desde el anterior, no desde el día que pagó', () => {
        // Venció el 15 y pagó el 18: el próximo sigue siendo el 15.
        expect(avanzarVencimiento('2026-10-15', '2026-10-18', 'mensual')).toBe('2026-11-15');
        expect(avanzarVencimiento('2026-10-15', '2026-10-10', 'trimestral')).toBe('2027-01-15');
    });

    it('sin vencimiento previo cuenta desde el día del pago', () => {
        expect(avanzarVencimiento(null, '2026-10-12', 'mensual')).toBe('2026-11-12');
        expect(avanzarVencimiento(undefined, '2026-10-12', 'anual')).toBe('2027-10-12');
    });

    it('si se atrasó varios periodos, el próximo vencimiento no queda en el pasado', () => {
        expect(avanzarVencimiento('2026-06-15', '2026-10-12', 'mensual')).toBe('2026-10-15');
        expect(avanzarVencimiento('2026-06-15', '2026-10-20', 'mensual')).toBe('2026-11-15');
    });
});

describe('comisión del mes', () => {
    it('acumula con la tasa y proyecta con el ritmo desde el tercer día', () => {
        // 10 días, 3 000 vendidos al 5%: lleva 150 y a este ritmo cierra en 465 (31 días).
        expect(comisionDelMes(3000, 5, '2026-10-10')).toEqual({ acumulada: 150, proyectada: 465 });
    });

    it('en los dos primeros días no se proyecta', () => {
        expect(comisionDelMes(500, 5, '2026-10-02')).toEqual({ acumulada: 25, proyectada: null });
    });

    it('sin tasa o sin ventas no hay comisión', () => {
        expect(comisionDelMes(3000, null, '2026-10-10')).toEqual({ acumulada: 0, proyectada: null });
        expect(comisionDelMes(0, 5, '2026-10-10')).toEqual({ acumulada: 0, proyectada: null });
    });
});

describe('propuesta para el cliente', () => {
    const base = { modelo: 'ninguno' as const, cuotaFija: null, frecuencia: 'mensual', tasa: null, ventasMes: 0, ventasMesesAnteriores: [0, 0, 0], moneda: 'PEN' };

    it('sin ventas no inventa nada', () => {
        const p = proponerPlan(base);
        expect(p.recomendacion).toBe('sin_datos');
        expect(p.escenarios).toEqual([]);
    });

    it('sin plan pactado propone definir uno, con una referencia', () => {
        const p = proponerPlan({ ...base, ventasMesesAnteriores: [10000, 10000, 10000] });
        expect(p.recomendacion).toBe('definir_plan');
        expect(p.ventasPromedio).toBe(10000);
        expect(p.texto).toMatch(/S\/ 500\.00/);
    });

    it('un cliente a comisión recibe la opción de cuota fija equivalente', () => {
        const p = proponerPlan({ ...base, modelo: 'comision', tasa: 5, ventasMesesAnteriores: [12000, 10000, 8000] });
        expect(p.recomendacion).toBe('pasar_a_fijo');
        expect(p.escenarios).toEqual([{ modelo: 'comision', etiqueta: 'Comisión del 5%', costoMensual: 500 }]);
        expect(p.tendencia).toBe('sube');
        expect(p.texto).toMatch(/cuota fija/i);
    });

    it('un cliente con cuota baja frente a lo que daría la comisión: se propone pasar a comisión', () => {
        const p = proponerPlan({ ...base, modelo: 'mixto', cuotaFija: 200, tasa: 5, ventasMesesAnteriores: [10000, 10000, 10000] });
        expect(p.escenarios.map(s => [s.modelo, s.costoMensual])).toEqual([['fijo', 200], ['comision', 500]]);
        expect(p.recomendacion).toBe('pasar_a_comision');
    });

    it('un cliente cuya cuota supera su comisión: se avisa de que le sale cara', () => {
        const p = proponerPlan({ ...base, modelo: 'mixto', cuotaFija: 900, tasa: 5, ventasMesesAnteriores: [10000, 10000, 10000] });
        expect(p.recomendacion).toBe('pasar_a_fijo');
        expect(p.titulo).toMatch(/cara/);
    });

    it('cuota y comisión parecidas: mantener', () => {
        const p = proponerPlan({ ...base, modelo: 'mixto', cuotaFija: 480, tasa: 5, ventasMesesAnteriores: [10000, 10000, 10000] });
        expect(p.recomendacion).toBe('mantener');
    });

    it('solo cuota fija: dice qué porcentaje de sus ventas representa', () => {
        const p = proponerPlan({ ...base, modelo: 'fijo', cuotaFija: 300, ventasMesesAnteriores: [10000, 10000, 10000] });
        expect(p.recomendacion).toBe('mantener');
        expect(p.texto).toMatch(/3%/);
    });

    it('una cuota trimestral se compara por su aporte mensual', () => {
        const p = proponerPlan({ ...base, modelo: 'fijo', cuotaFija: 900, frecuencia: 'trimestral', ventasMesesAnteriores: [10000, 10000, 10000] });
        expect(p.escenarios[0]).toMatchObject({ modelo: 'fijo', costoMensual: 300 });
    });

    it('detecta la tendencia a la baja', () => {
        const p = proponerPlan({ ...base, modelo: 'comision', tasa: 5, ventasMesesAnteriores: [5000, 10000, 10000] });
        expect(p.tendencia).toBe('baja');
    });
});
