/**
 * Productos ganadores: lo más vendido de un periodo, con cuánto stock queda y en cuánto tiempo se agotaría.
 *
 * El ritmo de venta se mide siempre sobre los últimos 30 días (no sobre el periodo que se esté mirando), para que «en cuánto se
 * agota» no cambie según el filtro de fechas. Si el producto empezó a venderse hace poco, el ritmo se calcula sobre los días que
 * lleva vendiéndose y no sobre 30: dividir entre 30 un producto con 3 días de venta lo haría parecer lento.
 */

export const VENTANA_DE_RITMO_DIAS = 30;
/** Hasta estos días de stock se pide reponer ya. */
export const DIAS_CRITICO = 7;
/** Hasta estos días de stock se pide reponer pronto. */
export const DIAS_PRONTO = 15;
/** El pedido sugerido cubre estos días de venta. */
export const DIAS_A_CUBRIR = 30;

export type EstadoDeStock = 'agotado' | 'critico' | 'pronto' | 'suficiente' | 'sin_ventas';

export interface LineaDeVenta {
    /** Producto de Synkro si se conoce; si no, el SKU. Es lo que une la misma cosa vendida en canales distintos. */
    clave: string;
    cantidad: number;
    /** Lo que pagó el cliente por esa línea (precio × cantidad, sin envío). */
    ingreso: number;
    /** Día de la venta, AAAA-MM-DD (hora de Lima). */
    fecha: string;
    pedido: string;
}

export interface AcumuladoDeProducto {
    clave: string;
    unidades: number;
    ingresos: number;
    pedidos: number;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function acumularVentas(lineas: LineaDeVenta[]): Map<string, AcumuladoDeProducto> {
    const porClave = new Map<string, AcumuladoDeProducto & { _pedidos: Set<string> }>();
    for (const l of lineas) {
        if (!l.clave || !(l.cantidad > 0)) continue;
        const a = porClave.get(l.clave) ?? { clave: l.clave, unidades: 0, ingresos: 0, pedidos: 0, _pedidos: new Set<string>() };
        a.unidades += l.cantidad;
        a.ingresos += l.ingreso;
        a._pedidos.add(l.pedido);
        porClave.set(l.clave, a);
    }
    const salida = new Map<string, AcumuladoDeProducto>();
    for (const [k, a] of porClave) salida.set(k, { clave: a.clave, unidades: a.unidades, ingresos: r2(a.ingresos), pedidos: a._pedidos.size });
    return salida;
}

/** Días entre dos fechas AAAA-MM-DD, contando ambos extremos. */
export function diasEntre(desde: string, hasta: string): number {
    const d = (new Date(`${hasta}T12:00:00Z`).getTime() - new Date(`${desde}T12:00:00Z`).getTime()) / 86_400_000;
    return Math.max(1, Math.round(d) + 1);
}

export interface RitmoDeVenta {
    unidades: number;
    /** Días sobre los que se midió: 30, o menos si el producto empezó a venderse hace poco. */
    dias: number;
    porDia: number;
}

/** Ritmo de venta de cada producto en los últimos 30 días (`hoy` incluido). */
export function ritmoPorProducto(lineas: LineaDeVenta[], hoy: string): Map<string, RitmoDeVenta> {
    const inicio = new Date(new Date(`${hoy}T12:00:00Z`).getTime() - (VENTANA_DE_RITMO_DIAS - 1) * 86_400_000).toISOString().slice(0, 10);
    const base = new Map<string, { unidades: number; primera: string }>();
    for (const l of lineas) {
        if (!l.clave || !(l.cantidad > 0) || l.fecha < inicio || l.fecha > hoy) continue;
        const b = base.get(l.clave) ?? { unidades: 0, primera: l.fecha };
        b.unidades += l.cantidad;
        if (l.fecha < b.primera) b.primera = l.fecha;
        base.set(l.clave, b);
    }
    const salida = new Map<string, RitmoDeVenta>();
    for (const [clave, b] of base) {
        const dias = Math.min(VENTANA_DE_RITMO_DIAS, diasEntre(b.primera, hoy));
        salida.set(clave, { unidades: b.unidades, dias, porDia: b.unidades / dias });
    }
    return salida;
}

export interface EstimacionDeStock {
    estado: EstadoDeStock;
    /** Unidades por día según los últimos 30 días. */
    porDia: number;
    /** En cuántos días se agota al ritmo actual; null si no hay ventas o ya está agotado. */
    dias: number | null;
    /** Fecha estimada de agotamiento (AAAA-MM-DD). */
    agotaEl: string | null;
    /** Unidades a pedir para cubrir los próximos 30 días (0 si ya alcanza). */
    sugerido: number;
    recomendacion: string;
}

export function estimarStock(stock: number | null | undefined, ritmo: RitmoDeVenta | null | undefined, hoy: string): EstimacionDeStock {
    const porDia = ritmo?.porDia ?? 0;
    const unidades = Math.max(0, Math.trunc(Number(stock ?? 0)) || 0);
    const sugeridoPara = (cubrir: number) => Math.max(0, Math.ceil(porDia * cubrir - unidades));

    if (unidades === 0) {
        return { estado: 'agotado', porDia: r2(porDia), dias: null, agotaEl: null, sugerido: sugeridoPara(DIAS_A_CUBRIR), recomendacion: 'Sin stock: repón ya' };
    }
    if (porDia <= 0) {
        return { estado: 'sin_ventas', porDia: 0, dias: null, agotaEl: null, sugerido: 0, recomendacion: `Sin ventas en ${VENTANA_DE_RITMO_DIAS} días` };
    }
    const dias = unidades / porDia;
    const agotaEl = new Date(new Date(`${hoy}T12:00:00Z`).getTime() + Math.floor(dias) * 86_400_000).toISOString().slice(0, 10);
    const estado: EstadoDeStock = dias <= DIAS_CRITICO ? 'critico' : dias <= DIAS_PRONTO ? 'pronto' : 'suficiente';
    const recomendacion = estado === 'critico' ? 'Repón ya' : estado === 'pronto' ? 'Pide pronto' : 'Stock suficiente';
    return { estado, porDia: r2(porDia), dias: Math.round(dias * 10) / 10, agotaEl, sugerido: estado === 'suficiente' ? 0 : sugeridoPara(DIAS_A_CUBRIR), recomendacion };
}

export type CriterioDeOrden = 'units' | 'revenue' | 'days';

/** Orden de la lista: más unidades, más ingresos o el que se agota antes (los agotados primero; los sin ventas al final). */
export function ordenarGanadores<T extends { unidades: number; ingresos: number; stockEstimado: EstimacionDeStock }>(items: T[], criterio: CriterioDeOrden): T[] {
    const urgencia = (i: T) => (i.stockEstimado.estado === 'agotado' ? -1 : i.stockEstimado.dias ?? Number.POSITIVE_INFINITY);
    const copia = [...items];
    copia.sort((a, b) => {
        if (criterio === 'revenue') return b.ingresos - a.ingresos || b.unidades - a.unidades;
        if (criterio === 'days') return urgencia(a) - urgencia(b) || b.unidades - a.unidades;
        return b.unidades - a.unidades || b.ingresos - a.ingresos;
    });
    return copia;
}
