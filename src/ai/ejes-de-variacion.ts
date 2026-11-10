export interface EjeParaIA {
    name: string;
    values: string[];
}

/**
 * Lo que la IA debe saber de un producto con variantes: es UNA sola publicación con varias opciones, y cuáles son.
 * Va junto al texto del producto, así llega a todas las etapas (categoría, atributos, descripción y ficha HTML).
 * Sin ejes (producto simple) devuelve vacío.
 */
export function textoDeEjes(ejes?: EjeParaIA[] | null): string {
    const lineas = (ejes ?? [])
        .map((e) => ({ name: String(e?.name ?? '').trim(), values: [...new Set((e?.values ?? []).map((v) => String(v ?? '').trim()).filter(Boolean))] }))
        .filter((e) => e.name && e.values.length)
        .map((e) => `- ${e.name}: ${e.values.join(', ')}`);
    if (!lineas.length) return '';
    return [
        'Este producto se vende como UNA sola publicación con varias opciones (variantes). Opciones disponibles:',
        ...lineas,
        'El título, la descripción y los atributos son GENERALES para todas las variantes: no los limites a un solo valor de estas opciones. Puedes mencionar qué opciones existen.',
    ].join('\n');
}
