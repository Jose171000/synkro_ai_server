/**
 * La categoría de cada canal que un producto YA tiene (la eligió una persona o una IA anterior) no se cambia al regenerar con IA:
 * regenerar rellena lo vacío, no reabre decisiones. Estas funciones puras lo garantizan para todos los canales.
 */

/** Las categorías ya guardadas, por canal: { falabella: '3223', ripley: 'R141100000000', … }. */
export function categoriasElegidas(
    marketplaceIds: Record<string, any> | null | undefined,
    aiAttributes?: Record<string, any> | null,
): Record<string, string> {
    const salida: Record<string, string> = {};
    for (const [clave, valor] of Object.entries(marketplaceIds ?? {})) {
        const m = /^([a-z0-9]+)_category_id$/i.exec(clave);
        const id = String(valor ?? '').trim();
        if (m && id) salida[m[1].toLowerCase()] = id;
    }
    // Mercado Libre también la guardó a veces dentro de los atributos.
    const meli = String(aiAttributes?.mercadolibre_category_id ?? '').trim();
    if (!salida.mercadolibre && meli) salida.mercadolibre = meli;
    return salida;
}

/** Une lo que propone la IA con lo que el producto ya tenía: una categoría ya guardada manda; la IA solo rellena las que faltan. */
export function fusionarCategorias(previos: Record<string, any> | null | undefined, nuevos: Record<string, any> | null | undefined): Record<string, any> {
    const salida: Record<string, any> = { ...(previos ?? {}) };
    for (const [clave, valor] of Object.entries(nuevos ?? {})) {
        if (/_category_id$/i.test(clave) && String(salida[clave] ?? '').trim()) continue;
        salida[clave] = valor;
    }
    return salida;
}
