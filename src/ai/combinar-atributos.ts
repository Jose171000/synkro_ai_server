const vacio = (v: any) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const esObjeto = (v: any) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Suma lo que la IA acaba de generar a los atributos que el producto ya tenía, sin pisar nada: lo que ya tiene valor
 * se queda (puede ser un dato real del canal o algo que una persona revisó) y la IA solo rellena lo que estaba vacío.
 * Los grupos de atributos (p. ej. los de Mercado Libre) se combinan clave por clave con la misma regla.
 */
export function combinarAtributos(previos: Record<string, any> | null | undefined, nuevos: Record<string, any> | null | undefined): Record<string, any> {
    const base = previos ?? {};
    const salida: Record<string, any> = { ...(nuevos ?? {}) };
    for (const [clave, previo] of Object.entries(base)) {
        if (vacio(previo)) continue;
        salida[clave] = esObjeto(previo) && esObjeto(salida[clave]) ? combinarAtributos(previo, salida[clave]) : previo;
    }
    return salida;
}
