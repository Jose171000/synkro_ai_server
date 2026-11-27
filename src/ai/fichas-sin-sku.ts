/** El SKU es de manejo interno: las fichas van a la IA con un número (F1, F2…) y sin ningún dato que sea su SKU. */
export interface FichaConSku { sellerSku: string; nombre: string; variation: string | null; atributos: Record<string, string> }

export function fichaSinSku(f: FichaConSku, etiqueta: string): string {
    const sku = String(f.sellerSku ?? '').trim().toLowerCase();
    const esElSku = (v: unknown) => !!sku && String(v ?? '').trim().toLowerCase() === sku;
    const sinSku = (t: string) => (sku.length >= 3 ? t.split(new RegExp(sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).join(' ').replace(/\s+/g, ' ').trim() : t);
    const atributos = Object.fromEntries(Object.entries(f.atributos ?? {}).filter(([k, v]) => !/sku/i.test(k) && !esElSku(v)));
    const variacion = f.variation && !esElSku(f.variation) ? f.variation : '-';
    return `- ${etiqueta} | título: ${sinSku(f.nombre).slice(0, 160)} | variación: ${variacion} | atributos: ${JSON.stringify(atributos)}`;
}

/** Devuelve la respuesta de la IA (por F1, F2…) indexada por el SKU de cada ficha. */
export function porSku<T>(valores: Record<string, T> | null | undefined, fichas: FichaConSku[]): Record<string, T> {
    const salida: Record<string, T> = {};
    fichas.forEach((f, i) => {
        const v = valores?.[`F${i + 1}`];
        if (v !== undefined) salida[f.sellerSku] = v;
    });
    return salida;
}
