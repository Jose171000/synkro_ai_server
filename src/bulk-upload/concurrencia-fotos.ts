/**
 * Cuántos productos de una carga masiva suben sus fotos a la vez (variable BULK_PHOTO_CONCURRENCY).
 *
 * Sin la variable, o con un valor que no sirve, no hay límite: el comportamiento de siempre (todos a la vez).
 * Con una carga grande conviene fijar un número (por ejemplo 8) para no tener cientos de subidas a Cloudinary
 * y cientos de fotos en memoria al mismo tiempo. El tope evita un error de tipeo en el otro sentido.
 */
export const FOTOS_SIN_LIMITE = 0;
export const FOTOS_CONCURRENCIA_MAXIMA = 50;

export function concurrenciaDeFotos(valor: string | undefined): number {
    const texto = String(valor ?? '').trim();
    if (!/^\d+$/.test(texto)) return FOTOS_SIN_LIMITE;
    return Math.min(Number(texto), FOTOS_CONCURRENCIA_MAXIMA);
}

/**
 * Igual que `Promise.allSettled(items.map(fn))`, pero con a lo más `limite` tareas en curso (0 = todas a la vez).
 * El resultado conserva el orden de `items`.
 */
export async function allSettledConLimite<T, R>(
    items: readonly T[],
    limite: number,
    fn: (item: T, indice: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
    if (limite < 1 || limite >= items.length) return Promise.allSettled(items.map((item, i) => fn(item, i)));

    const resultados: PromiseSettledResult<R>[] = new Array(items.length);
    let siguiente = 0;
    const trabajador = async () => {
        while (siguiente < items.length) {
            const i = siguiente++;
            try {
                resultados[i] = { status: 'fulfilled', value: await fn(items[i], i) };
            } catch (reason) {
                resultados[i] = { status: 'rejected', reason };
            }
        }
    };
    await Promise.all(Array.from({ length: limite }, trabajador));
    return resultados;
}
