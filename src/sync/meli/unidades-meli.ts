/** Atributos de medida de Mercado Libre (alto, ancho, largo, profundidad): piden el número con su unidad («35 cm»). */
const MEDIDA_EN_CM = /(^|_)(HEIGHT|WIDTH|DEPTH|LENGTH)$/;

/** Un número suelto en una medida se envía en centímetros; Mercado Libre rechaza «35» con «The provided unit is not valid». */
export function conUnidadMeli(id: string, valor: string): string {
    const v = String(valor ?? '').trim();
    return MEDIDA_EN_CM.test(String(id)) && /^\d+([.,]\d+)?$/.test(v) ? `${v} cm` : v;
}

/**
 * Las medidas obligatorias de la categoría que la IA dejó vacías se toman de las medidas estimadas del paquete (en cm).
 * Devuelve solo lo que se completó, para marcarlo como estimado y que la persona lo revise.
 */
export function medidasQueFaltan(
    atributos: Record<string, unknown>,
    requisitos: { name: string; isRequired?: boolean }[],
    paquete: { width: number; length: number; height: number } | null | undefined,
): Record<string, string> {
    if (!paquete) return {};
    const deCaja = (id: string): number | undefined => {
        if (/HEIGHT$/.test(id)) return paquete.height;
        if (/WIDTH$/.test(id)) return paquete.width;
        if (/(DEPTH|LENGTH)$/.test(id)) return paquete.length;
        return undefined;
    };
    const nuevos: Record<string, string> = {};
    for (const r of requisitos ?? []) {
        if (!r.isRequired || !MEDIDA_EN_CM.test(r.name)) continue;
        if (String(atributos?.[r.name] ?? '').trim()) continue;
        const cm = deCaja(r.name);
        if (cm && cm > 0) nuevos[r.name] = `${Math.round(cm * 10) / 10} cm`;
    }
    return nuevos;
}
