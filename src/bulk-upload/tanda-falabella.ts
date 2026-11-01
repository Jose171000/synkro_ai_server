/**
 * Cuántos productos de una carga masiva se mandan juntos a Falabella (variable FALABELLA_BATCH_SIZE).
 *
 * Falabella limita las LLAMADAS de publicación (50 sin espera y luego una cada 2 minutos), no los productos de cada una:
 * una tanda grande gasta pocas llamadas. Sin la variable (o con un valor que no sirve) no hay tandas: todo el lote se
 * manda junto al terminar, como siempre. El tope es el tamaño máximo de envío que ya usa la publicación.
 */
export const TANDA_FALABELLA_SIN_TANDAS = 0;
export const TANDA_FALABELLA_MAXIMA = 500;

export function tamanoDeTandaFalabella(valor: string | undefined): number {
    const texto = String(valor ?? '').trim();
    if (!/^\d+$/.test(texto)) return TANDA_FALABELLA_SIN_TANDAS;
    return Math.min(Number(texto), TANDA_FALABELLA_MAXIMA);
}
