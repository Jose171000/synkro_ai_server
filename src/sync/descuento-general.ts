/**
 * Descuento general de un producto: una sola definición (en soles o en porcentaje, con fecha de fin obligatoria)
 * que se aplica a todos los canales. Aquí solo hay cálculo y validación, sin tocar la base ni ningún canal.
 */

export interface PedidoDeDescuento {
    modo: 'precio' | 'porcentaje';
    /** «precio»: el precio con descuento en soles. «porcentaje»: el % a rebajar (0 < % < 100). */
    valor: number;
    /** AAAA-MM-DD; si falta, empieza hoy. */
    desde?: string | null;
    /** AAAA-MM-DD; obligatoria. */
    hasta?: string | null;
}

export interface DescuentoCalculado {
    salePrice: number;
    /** Porcentaje real que representa, con un decimal. */
    porcentaje: number;
    desde: string;
    hasta: string;
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const DIA_MS = 24 * 3600 * 1000;

/** Hoy en AAAA-MM-DD (hora de Lima, UTC-5, sin horario de verano). */
export function hoyEnLima(ahora: Date = new Date()): string {
    return new Date(ahora.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

const aMs = (f: string) => Date.parse(`${f}T00:00:00Z`);
const deMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function fechaValida(f: string): boolean {
    return FECHA.test(f) && deMs(aMs(f)) === f;
}

/** Calcula el precio con descuento de UN producto y valida fechas. Lanza Error con un mensaje para la persona. */
export function calcularDescuento(precioRegular: number, pedido: PedidoDeDescuento, hoy: string = hoyEnLima()): DescuentoCalculado {
    const regular = Number(precioRegular);
    if (!(regular > 0)) throw new Error('El producto no tiene un precio regular válido.');
    const valor = Number(pedido.valor);
    if (!(valor > 0)) throw new Error('El descuento debe ser mayor que 0.');

    let salePrice: number;
    if (pedido.modo === 'porcentaje') {
        if (!(valor < 100)) throw new Error('El porcentaje de descuento debe ser menor que 100.');
        salePrice = Math.round(regular * (1 - valor / 100) * 100) / 100;
    } else {
        salePrice = Math.round(valor * 100) / 100;
    }
    if (!(salePrice > 0) || !(salePrice < regular)) {
        throw new Error(`El precio con descuento debe ser mayor que 0 y menor que el precio regular (${regular.toFixed(2)}).`);
    }

    const hasta = String(pedido.hasta ?? '').trim();
    if (!hasta) throw new Error('El descuento necesita una fecha de fin (AAAA-MM-DD).');
    if (!fechaValida(hasta)) throw new Error('La fecha de fin no es válida (usa AAAA-MM-DD).');
    const desde = String(pedido.desde ?? '').trim() || hoy;
    if (!fechaValida(desde)) throw new Error('La fecha de inicio no es válida (usa AAAA-MM-DD).');
    if (hasta < hoy) throw new Error('La fecha de fin ya pasó.');
    if (hasta < desde) throw new Error('La fecha de fin no puede ser anterior a la de inicio.');

    return { salePrice, porcentaje: Math.round((1 - salePrice / regular) * 1000) / 10, desde, hasta };
}

export interface Tramo {
    desde: string;
    hasta: string;
}

/**
 * Parte el periodo del descuento en tramos consecutivos de a lo sumo `maxDias` días (ambos extremos incluidos):
 * Mercado Libre limita cuánto dura cada promoción, así que se crean una tras otra hasta la fecha de fin.
 */
export function partirEnTramos(desde: string, hasta: string, maxDias: number): Tramo[] {
    const tope = Math.max(1, Math.floor(Number(maxDias) || 1));
    if (!fechaValida(desde) || !fechaValida(hasta) || hasta < desde) return [];
    const tramos: Tramo[] = [];
    let inicio = aMs(desde);
    const fin = aMs(hasta);
    while (inicio <= fin) {
        const finTramo = Math.min(inicio + (tope - 1) * DIA_MS, fin);
        tramos.push({ desde: deMs(inicio), hasta: deMs(finTramo) });
        inicio = finTramo + DIA_MS;
    }
    return tramos;
}

/** El tramo que corresponde a un día (o null si el descuento aún no empieza o ya terminó). */
export function tramoDelDia(tramos: Tramo[], dia: string): Tramo | null {
    return tramos.find((t) => t.desde <= dia && dia <= t.hasta) ?? null;
}

/** El siguiente tramo después de uno dado (para crearlo antes de que venza el actual). */
export function tramoSiguiente(tramos: Tramo[], actual: Tramo): Tramo | null {
    const i = tramos.findIndex((t) => t.desde === actual.desde);
    return i >= 0 ? tramos[i + 1] ?? null : null;
}
