import { partirEnTramos, Tramo, tramoDelDia } from '../descuento-general';

/**
 * Descuento individual de Mercado Libre (PRICE_DISCOUNT). Reglas de su documentación (Perú):
 *  - dura como máximo 14 días por promoción: un descuento largo se reparte en tramos consecutivos;
 *  - el descuento debe estar entre 5% y 80%;
 *  - subir el precio de la publicación quita los descuentos.
 * Aquí solo se decide QUÉ hacer; nada se envía.
 */

/** Plazo máximo por promoción. Configurable por si Mercado Libre lo cambia. */
export function maxDiasPromoMeli(): number {
    const n = Math.floor(Number(process.env.MELI_PROMO_MAX_DIAS));
    return n >= 1 ? n : 14;
}

/** Los descuentos de Mercado Libre solo se mandan con este interruptor encendido (MELI_PROMOS_ACTIVAS=true). */
export function promosMeliActivas(): boolean {
    return String(process.env.MELI_PROMOS_ACTIVAS ?? '').toLowerCase() === 'true';
}

export const DESCUENTO_MIN_MELI = 5;
export const DESCUENTO_MAX_MELI = 80;

export interface EntradaDePlanMeli {
    /** Precio regular que tiene la publicación. */
    precio: number;
    /** El descuento general vigente (null si no hay). */
    promo: { salePrice: number; start: string | null; end: string | null } | null;
    /** Lo último que se le puso a esta publicación: «precio|desde|hasta» o vacío. */
    ultima: string | null;
    /** Hoy en AAAA-MM-DD (Lima). */
    hoy: string;
    maxDias: number;
}

export type PlanMeli =
    | { tipo: 'nada' }
    /** Hay una promoción puesta que ya no corresponde (se quitó el descuento o terminó). */
    | { tipo: 'quitar' }
    | { tipo: 'poner'; quitarAntes: boolean; dealPrice: number; desde: string; hasta: string; firma: string }
    /** No se puede aplicar (porcentaje fuera de rango…); si había una promoción previa, también se quita. */
    | { tipo: 'omitir'; motivo: string; quitarAntes: boolean };

export const firmaDeTramo = (salePrice: number, t: Tramo) => `${salePrice}|${t.desde}|${t.hasta}`;

export function planDeDescuentoMeli(e: EntradaDePlanMeli): PlanMeli {
    const hayPrevia = !!(e.ultima && e.ultima.trim());
    if (!e.promo) return hayPrevia ? { tipo: 'quitar' } : { tipo: 'nada' };

    const { salePrice } = e.promo;
    const hasta = e.promo.end;
    if (!hasta) {
        // El descuento general siempre trae fecha de fin; sin ella no se arriesga a dejar una promoción abierta.
        return { tipo: 'omitir', motivo: 'El descuento no tiene fecha de fin.', quitarAntes: hayPrevia };
    }
    const pct = (1 - salePrice / e.precio) * 100;
    if (!(e.precio > 0) || pct < DESCUENTO_MIN_MELI || pct >= DESCUENTO_MAX_MELI) {
        return {
            tipo: 'omitir',
            motivo: `Mercado Libre solo acepta descuentos entre ${DESCUENTO_MIN_MELI}% y ${DESCUENTO_MAX_MELI}% (este es de ${Math.round(pct * 10) / 10}%).`,
            quitarAntes: hayPrevia,
        };
    }

    const desde = e.promo.start && e.promo.start > e.hoy ? e.promo.start : e.hoy;
    if (hasta < e.hoy) return hayPrevia ? { tipo: 'quitar' } : { tipo: 'nada' }; // ya terminó
    const tramos = partirEnTramos(e.promo.start ?? e.hoy, hasta, e.maxDias);
    // Antes de empezar se programa el primer tramo; en marcha, el del día.
    const tramo = tramoDelDia(tramos, e.hoy) ?? (desde > e.hoy ? tramos[0] ?? null : null);
    if (!tramo) return hayPrevia ? { tipo: 'quitar' } : { tipo: 'nada' };

    const firma = firmaDeTramo(salePrice, tramo);
    if (e.ultima === firma) return { tipo: 'nada' };
    return { tipo: 'poner', quitarAntes: hayPrevia, dealPrice: salePrice, desde: tramo.desde, hasta: tramo.hasta, firma };
}
