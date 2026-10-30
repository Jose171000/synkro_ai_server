/**
 * Cuántos productos de una carga masiva se procesan a la vez (variable AI_QUEUE_CONCURRENCY).
 *
 * Sin la variable, o con un valor que no sirve, se queda en 1: el comportamiento de siempre.
 * El tope evita que un error de tipeo (600 en vez de 6) lance cientos de llamadas a la IA a la vez.
 */
export const CONCURRENCIA_IA_POR_DEFECTO = 1;
export const CONCURRENCIA_IA_MAXIMA = 20;

export function concurrenciaDeLaCola(valor: string | undefined, porDefecto = CONCURRENCIA_IA_POR_DEFECTO, maximo = CONCURRENCIA_IA_MAXIMA): number {
    const texto = String(valor ?? '').trim();
    if (!/^\d+$/.test(texto)) return porDefecto;
    const n = Number(texto);
    if (n < 1) return porDefecto;
    return Math.min(n, maximo);
}

/** Se lee una vez al arrancar: el decorador del procesador la necesita al cargar la clase. */
export const CONCURRENCIA_IA = concurrenciaDeLaCola(process.env.AI_QUEUE_CONCURRENCY);
