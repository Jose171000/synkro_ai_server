/**
 * Las fotos que la IA mira de un producto con variantes: UNA de cada variante (la primera, sin repetir la misma foto) hasta llegar
 * al límite de fotos que admite el análisis; si sobra lugar, se completa con las demás fotos de las variantes.
 * Así la IA ve los distintos colores o modelos en vez de varias fotos de la primera variante.
 */
export function fotosParaIA(variantes: { images?: { url?: string | null }[] | null }[], max: number): string[] {
    const primeras = variantes.map((v) => v.images?.[0]?.url).filter(Boolean) as string[];
    const resto = variantes.flatMap((v) => (v.images ?? []).slice(1).map((i) => i.url)).filter(Boolean) as string[];
    return [...new Set([...primeras, ...resto])].slice(0, max);
}
