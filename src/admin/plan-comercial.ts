/**
 * Reglas del plan comercial de cada cliente: qué se le cobra, cuándo vence y
 * cuánto lleva acumulado en comisión. Son funciones puras (sin base de datos)
 * para que las cifras que ve el cliente y las que ve la agencia sean siempre
 * las mismas y se puedan comprobar con pruebas.
 */

export type ModeloDeCobro = 'ninguno' | 'fijo' | 'comision' | 'mixto';
export type Frecuencia = 'mensual' | 'trimestral' | 'anual';
export type EstadoDePago = 'al_dia' | 'por_vencer' | 'vence_hoy' | 'vencido';

export const MODELOS_DE_COBRO: ModeloDeCobro[] = ['ninguno', 'fijo', 'comision', 'mixto'];
export const FRECUENCIAS: Frecuencia[] = ['mensual', 'trimestral', 'anual'];

/** Con cuántos días de margen un vencimiento pasa a «por vencer». */
export const DIAS_DE_AVISO = 7;

const redondear = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const MESES: Record<Frecuencia, number> = { mensual: 1, trimestral: 3, anual: 12 };

/** Hoy en Lima (UTC-5) como YYYY-MM-DD: el cobro se piensa en la fecha del país, no en la del servidor. */
export function hoyEnLima(ahora: Date = new Date()): string {
    return new Date(ahora.getTime() - 5 * 3600_000).toISOString().slice(0, 10);
}

/** Suma meses a una fecha YYYY-MM-DD sin salirse del mes (31 de enero + 1 mes = 28/29 de febrero). */
export function sumarMeses(fecha: string, meses: number): string {
    const [a, m, d] = fecha.split('-').map(Number);
    const destino = new Date(Date.UTC(a, m - 1 + meses, 1));
    const ultimoDia = new Date(Date.UTC(destino.getUTCFullYear(), destino.getUTCMonth() + 1, 0)).getUTCDate();
    destino.setUTCDate(Math.min(d, ultimoDia));
    return destino.toISOString().slice(0, 10);
}

export function diasEntre(desde: string, hasta: string): number {
    const utc = (f: string) => { const [a, m, d] = f.split('-').map(Number); return Date.UTC(a, m - 1, d); };
    return Math.round((utc(hasta) - utc(desde)) / 86_400_000);
}

/** Cuánto aporta al mes una cuota que se paga cada `frecuencia`. */
export function mensualizar(cuota: number | null | undefined, frecuencia: Frecuencia | string | null | undefined): number {
    const monto = Number(cuota ?? 0);
    if (!(monto > 0)) return 0;
    return redondear(monto / (MESES[frecuencia as Frecuencia] ?? 1));
}

/** Estado del próximo pago: el cliente y la agencia lo ven igual. */
export function estadoDePago(proximoPago: string | null | undefined, hoy: string): { estado: EstadoDePago; dias: number } | null {
    if (!proximoPago) return null;
    const dias = diasEntre(hoy, proximoPago);
    if (dias < 0) return { estado: 'vencido', dias };
    if (dias === 0) return { estado: 'vence_hoy', dias };
    if (dias <= DIAS_DE_AVISO) return { estado: 'por_vencer', dias };
    return { estado: 'al_dia', dias };
}

/**
 * Nuevo vencimiento tras registrar un pago recurrente: se avanza un periodo
 * desde el vencimiento que se acaba de pagar, para no ir corriendo el día de
 * cobro si el cliente paga unos días tarde. Sin vencimiento previo, se cuenta
 * desde la fecha del pago.
 */
export function avanzarVencimiento(vencimientoActual: string | null | undefined, pagadoEl: string, frecuencia: Frecuencia | string | null | undefined): string {
    const pasos = MESES[frecuencia as Frecuencia] ?? 1;
    let base = vencimientoActual || pagadoEl;
    let siguiente = sumarMeses(base, pasos);
    // Si el cliente se atrasó varios periodos y paga hoy, el próximo vencimiento no puede quedar en el pasado.
    while (siguiente <= pagadoEl) {
        base = siguiente;
        siguiente = sumarMeses(base, pasos);
    }
    return siguiente;
}

/** Comisión acumulada a la fecha y proyección a fin de mes con el ritmo de ventas actual. */
export function comisionDelMes(ventasMes: number, tasa: number | null | undefined, hoy: string): {
    acumulada: number;
    proyectada: number | null;
} {
    const rate = Number(tasa ?? 0);
    if (!(rate > 0)) return { acumulada: 0, proyectada: null };
    const acumulada = redondear((Number(ventasMes) * rate) / 100);
    const [a, m, d] = hoy.split('-').map(Number);
    const diasDelMes = new Date(Date.UTC(a, m, 0)).getUTCDate();
    // En los primeros días el ritmo no dice nada: se proyecta solo desde el tercero.
    if (d < 3 || ventasMes <= 0) return { acumulada, proyectada: null };
    return { acumulada, proyectada: redondear((acumulada / d) * diasDelMes) };
}

export interface PlanEntrada {
    modelo: ModeloDeCobro;
    cuotaFija: number | null;
    frecuencia: Frecuencia | string | null;
    tasa: number | null;
    /** Ventas del mes en curso. */
    ventasMes: number;
    /** Ventas de cada uno de los últimos 3 meses completos, del más reciente al más antiguo. */
    ventasMesesAnteriores: number[];
    moneda: string;
}

export interface Escenario {
    modelo: 'fijo' | 'comision';
    etiqueta: string;
    costoMensual: number;
}

export interface Propuesta {
    recomendacion: 'sin_datos' | 'mantener' | 'pasar_a_fijo' | 'pasar_a_comision' | 'definir_plan';
    titulo: string;
    ventasPromedio: number;
    tendencia: 'sube' | 'baja' | 'estable' | null;
    escenarios: Escenario[];
    /** Borrador de mensaje para enviar al cliente. */
    texto: string;
}

const dinero = (n: number, moneda: string) => `${moneda === 'USD' ? '$' : 'S/'} ${n.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Propuesta para un cliente a partir de lo que de verdad vende. Compara lo que
 * costaría cada modelo con su ritmo de ventas y deja un borrador de mensaje.
 * Solo usa los datos del plan: si no hay tasa o cuota pactadas, ese escenario
 * no se inventa.
 */
export function proponerPlan(e: PlanEntrada): Propuesta {
    const meses = e.ventasMesesAnteriores.filter(v => v > 0);
    const ventasPromedio = meses.length ? redondear(meses.reduce((s, v) => s + v, 0) / meses.length) : 0;

    let tendencia: Propuesta['tendencia'] = null;
    if (e.ventasMesesAnteriores.length >= 2 && ventasPromedio > 0) {
        const reciente = e.ventasMesesAnteriores[0];
        const base = e.ventasMesesAnteriores.slice(1).filter(v => v > 0);
        const previo = base.length ? base.reduce((s, v) => s + v, 0) / base.length : 0;
        if (previo > 0) {
            const cambio = (reciente - previo) / previo;
            tendencia = cambio > 0.1 ? 'sube' : cambio < -0.1 ? 'baja' : 'estable';
        }
    }

    const escenarios: Escenario[] = [];
    const cuota = mensualizar(e.cuotaFija, e.frecuencia);
    if (cuota > 0) escenarios.push({ modelo: 'fijo', etiqueta: 'Cuota fija', costoMensual: cuota });
    if (e.tasa && e.tasa > 0 && ventasPromedio > 0) {
        escenarios.push({ modelo: 'comision', etiqueta: `Comisión del ${e.tasa}%`, costoMensual: redondear((ventasPromedio * e.tasa) / 100) });
    }

    const base = (titulo: string, recomendacion: Propuesta['recomendacion'], cuerpo: string): Propuesta => ({
        recomendacion,
        titulo,
        ventasPromedio,
        tendencia,
        escenarios,
        texto: cuerpo,
    });

    if (ventasPromedio <= 0) {
        return base('Aún sin ventas para proponer', 'sin_datos',
            'Todavía no hay meses completos con ventas para comparar modelos. Revisa de nuevo cuando haya al menos un mes cerrado.');
    }

    const fijo = escenarios.find(s => s.modelo === 'fijo');
    const comision = escenarios.find(s => s.modelo === 'comision');
    const tendenciaTxt = tendencia === 'sube' ? ' Sus ventas van en alza.' : tendencia === 'baja' ? ' Sus ventas han bajado.' : '';
    const ventasTxt = `En promedio vende ${dinero(ventasPromedio, e.moneda)} al mes.${tendenciaTxt}`;

    if (e.modelo === 'ninguno' || (!fijo && !comision)) {
        const sugerido = redondear(Math.round(((ventasPromedio * 0.05) / 10)) * 10);
        return base('Definir un plan', 'definir_plan',
            `${ventasTxt} Todavía no tiene un plan pactado. Define una cuota fija o un porcentaje de comisión; como referencia, un 5% sobre sus ventas equivaldría a ${dinero(sugerido, e.moneda)} al mes.`);
    }

    if (fijo && comision) {
        const diferencia = comision.costoMensual - fijo.costoMensual;
        if (diferencia > fijo.costoMensual * 0.2) {
            return base('La comisión rendiría más que la cuota', 'pasar_a_comision',
                `${ventasTxt} Hoy paga ${dinero(fijo.costoMensual, e.moneda)} fijos al mes; con ${comision.etiqueta.toLowerCase()} pagaría ${dinero(comision.costoMensual, e.moneda)}. ` +
                `Conviene proponerle pasar a comisión (o un plan mixto) si sus ventas se mantienen.`);
        }
        if (diferencia < -fijo.costoMensual * 0.2) {
            return base('La cuota fija le sale cara frente a su comisión', 'pasar_a_fijo',
                `${ventasTxt} Paga ${dinero(fijo.costoMensual, e.moneda)} fijos al mes, más de lo que sería la comisión (${dinero(comision.costoMensual, e.moneda)}). ` +
                `Para no perderlo conviene ofrecerle una cuota más ajustada o pasar a comisión.`);
        }
        return base('Su plan actual está equilibrado', 'mantener',
            `${ventasTxt} La cuota (${dinero(fijo.costoMensual, e.moneda)}) y la comisión (${dinero(comision.costoMensual, e.moneda)}) quedan muy parecidas: se puede mantener el plan.`);
    }

    if (comision) {
        const equivalente = redondear(Math.round(comision.costoMensual / 10) * 10);
        return base('Opción de cuota fija', 'pasar_a_fijo',
            `${ventasTxt} Con ${comision.etiqueta.toLowerCase()} paga unos ${dinero(comision.costoMensual, e.moneda)} al mes. ` +
            `Una cuota fija de ${dinero(equivalente, e.moneda)} le daría un costo predecible; si sus ventas crecen, a él le conviene el fijo y a nosotros la comisión.`);
    }

    const porcentaje = redondear((fijo!.costoMensual / ventasPromedio) * 100);
    return base('Su cuota equivale a un porcentaje de sus ventas', 'mantener',
        `${ventasTxt} Su cuota de ${dinero(fijo!.costoMensual, e.moneda)} representa un ${porcentaje}% de sus ventas. ` +
        (tendencia === 'sube' ? 'Como sus ventas suben, es buen momento de hablarle de un plan que crezca con él.' : 'Se puede mantener el plan.'));
}
