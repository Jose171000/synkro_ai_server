/**
 * Ripley solo acepta marcas de su catálogo aprobado (27.116) o «GENÉRICO». Aquí se busca en esa lista y se comprueba si una marca
 * escrita existe tal cual. Funciones puras, sin red ni base de datos.
 */

export const MARCA_GENERICA = 'GENÉRICO';

export const normalizarMarca = (t: unknown): string =>
    String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9Ñ]+/g, ' ').trim();

/** Marcas que contienen el texto: primero las que EMPIEZAN por él, luego las que lo traen en medio. Sin texto, las primeras de la lista. */
export function buscarMarcas(marcas: string[], texto: string, max = 30): string[] {
    const q = normalizarMarca(texto);
    if (!q) return (marcas ?? []).slice(0, max);
    const empiezan: string[] = [];
    const contienen: string[] = [];
    for (const m of marcas ?? []) {
        const n = normalizarMarca(m);
        if (n === q || n.startsWith(q)) empiezan.push(m);
        else if (n.includes(q)) contienen.push(m);
        if (empiezan.length >= max) break;
    }
    // La coincidencia exacta siempre va primero.
    empiezan.sort((a, b) => Number(normalizarMarca(b) === q) - Number(normalizarMarca(a) === q));
    return [...empiezan, ...contienen].slice(0, max);
}

/** La marca tal como está en la lista de Ripley (ignora mayúsculas y tildes), o null si no existe. */
export function marcaExacta(marcas: string[], texto: string): string | null {
    const q = normalizarMarca(texto);
    if (!q) return null;
    return (marcas ?? []).find((m) => normalizarMarca(m) === q) ?? null;
}

/** ¿Es válida la marca? Además de la canónica, devuelve sugerencias parecidas cuando no existe. */
export function revisarMarca(marcas: string[], texto: string): { valor: string; valida: boolean; canonica: string | null; sugerencias: string[] } {
    const valor = String(texto ?? '').trim();
    const canonica = marcaExacta(marcas, valor);
    return { valor, valida: !!canonica, canonica, sugerencias: canonica ? [] : buscarMarcas(marcas, valor, 5).filter((m) => normalizarMarca(m) !== normalizarMarca(valor)) };
}
