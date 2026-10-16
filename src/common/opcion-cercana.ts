const normalizar = (t: string) => t.trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const palabras = (t: string) => normalizar(t).split(/[^a-z0-9ñ]+/).filter((p) => p.length > 2);

/**
 * La opción de una lista cerrada que mejor corresponde a un valor escrito libremente
 * («madera de pino» → «Madera»). Devuelve la opción tal como la escribe el canal, o undefined si ninguna se parece.
 */
export function opcionCercana(valor: string, opciones: string[]): string | undefined {
    const buscado = normalizar(valor);
    if (!buscado || !opciones?.length) return undefined;

    const normalizadas = opciones.map((o) => ({ original: o, k: normalizar(o) }));

    const exacta = normalizadas.find((o) => o.k === buscado);
    if (exacta) return exacta.original;

    // Una contiene a la otra («madera de pino» contiene «madera»): la de longitud más parecida.
    const contenidas = normalizadas
        .filter((o) => o.k.length >= 3 && (buscado.includes(o.k) || o.k.includes(buscado)))
        .sort((a, b) => Math.abs(a.k.length - buscado.length) - Math.abs(b.k.length - buscado.length));
    if (contenidas.length) return contenidas[0].original;

    // Palabras en común.
    const mias = new Set(palabras(valor));
    if (!mias.size) return undefined;
    let mejor: { original: string; puntaje: number } | undefined;
    for (const o of normalizadas) {
        const suyas = new Set(palabras(o.original));
        if (!suyas.size) continue;
        const comunes = [...mias].filter((p) => suyas.has(p)).length;
        const puntaje = comunes / Math.min(mias.size, suyas.size);
        if (puntaje >= 0.5 && (!mejor || puntaje > mejor.puntaje)) mejor = { original: o.original, puntaje };
    }
    return mejor?.original;
}
