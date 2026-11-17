/**
 * Control del reenvío manual de fotos a Falabella. Falabella procesa las imágenes en diferido y limita las llamadas de feed de toda la
 * cuenta (50 seguidas y luego 2 minutos entre cada una): reenviar a cada momento no las acelera, repite el trabajo y puede frenar los
 * envíos de stock y precio de esa misma cuenta. Funciones puras: el servicio las aplica y guarda el registro.
 */

/** Tiempo mínimo entre dos reenvíos de un MISMO producto: Falabella tarda en descargar y revisar las fotos. */
export const ESPERA_ENTRE_REENVIOS_MS = 30 * 60_000;
/** Reenvíos manuales máximos por producto: si con 5 no entran, el problema no es de tiempo (URL, formato, tamaño). */
export const MAX_REENVIOS_POR_PRODUCTO = 5;
/** Productos que se aceptan por petición (3 feeds de 100). El resto se omite y se pide más tarde. */
export const MAX_PRODUCTOS_POR_PETICION = 300;
/** Pausa entre dos peticiones a la MISMA cuenta de Falabella (por sus límites de llamadas). */
export const PAUSA_ENTRE_PETICIONES_MS = 2 * 60_000;

/** Lo que se anota en el producto cada vez que se reenvían sus fotos. */
export interface RegistroDeReenvio { ultima?: string; veces?: number }

export type DecisionDeReenvio = { permitido: true } | { permitido: false; motivo: string };

export function decidirReenvio(registro: RegistroDeReenvio | null | undefined, ahora: number = Date.now()): DecisionDeReenvio {
    const veces = Number(registro?.veces ?? 0);
    if (veces >= MAX_REENVIOS_POR_PRODUCTO) {
        return { permitido: false, motivo: `ya se reenviaron sus fotos ${veces} veces sin resultado: revisa que las URLs de las fotos abran y sean JPG o PNG, o escribe a soporte de Falabella` };
    }
    const ultima = registro?.ultima ? Date.parse(registro.ultima) : NaN;
    if (!Number.isNaN(ultima) && ahora - ultima < ESPERA_ENTRE_REENVIOS_MS) {
        const faltan = Math.ceil((ESPERA_ENTRE_REENVIOS_MS - (ahora - ultima)) / 60_000);
        return { permitido: false, motivo: `sus fotos se reenviaron hace poco: espera ${faltan} min a que Falabella las procese` };
    }
    return { permitido: true };
}

/** El registro actualizado tras un reenvío. */
export function anotarReenvio(registro: RegistroDeReenvio | null | undefined, ahora: number = Date.now()): RegistroDeReenvio {
    return { ultima: new Date(ahora).toISOString(), veces: Number(registro?.veces ?? 0) + 1 };
}

/** Qué hace Synkro SOLO cuando Falabella dice que a una ficha le faltan las fotos. */
export type AccionAnteFotosFaltantes =
    | { accion: 'reenviar' }
    | { accion: 'esperar'; minutos: number }
    | { accion: 'rendirse'; motivo: string };

/**
 * Reenvío AUTOMÁTICO de fotos: mismos límites que el manual (espera de 30 min entre reenvíos del mismo producto y tope de 5), para no
 * saturar los límites de llamadas de Falabella. Si ya no quedan intentos, se rinde y la persona ve el motivo.
 */
export function decidirAutoReenvio(registro: RegistroDeReenvio | null | undefined, ahora: number = Date.now()): AccionAnteFotosFaltantes {
    const d = decidirReenvio(registro, ahora);
    if (d.permitido) return { accion: 'reenviar' };
    if (Number(registro?.veces ?? 0) >= MAX_REENVIOS_POR_PRODUCTO) return { accion: 'rendirse', motivo: d.motivo };
    const ultima = registro?.ultima ? Date.parse(registro.ultima) : ahora;
    return { accion: 'esperar', minutos: Math.max(1, Math.ceil((ESPERA_ENTRE_REENVIOS_MS - (ahora - ultima)) / 60_000)) };
}

/** Segundos que faltan para poder hacer otra petición a la misma cuenta; 0 si ya se puede. */
export function segundosParaOtraPeticion(ultimaPeticion: number | undefined, ahora: number = Date.now()): number {
    if (!ultimaPeticion) return 0;
    const faltan = PAUSA_ENTRE_PETICIONES_MS - (ahora - ultimaPeticion);
    return faltan > 0 ? Math.ceil(faltan / 1000) : 0;
}
