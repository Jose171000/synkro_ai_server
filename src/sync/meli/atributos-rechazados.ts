/**
 * Mercado Libre a veces rechaza un dato opcional («Attribute SSD_MAX_READ_SPEED with value 550 MB/s was omitted») y la publicación
 * entera falla por eso. Estas funciones puras sacan del mensaje de error qué atributos rechazó, para reintentar sin ellos.
 */

/** Los que identifican al producto: sin ellos la publicación no tiene sentido, así que nunca se quitan. */
const IMPRESCINDIBLES = new Set(['BRAND', 'MODEL', 'SELLER_SKU', 'GTIN', 'COLOR', 'MAIN_COLOR', 'SIZE']);

/** Códigos de atributo que el mensaje de Mercado Libre dice haber omitido o rechazado, sin repetir y sin los imprescindibles. */
export function atributosRechazadosPorMeli(mensaje: string): string[] {
    const ids = new Set<string>();
    const patrones = [
        /Attribute\s+([A-Z][A-Z0-9_]+)\s+with value/g,
        /attribute\s+\[?"?([A-Z][A-Z0-9_]+)"?\]?\s+(?:is|was)\s+(?:invalid|omitted)/gi,
    ];
    for (const p of patrones) {
        for (const m of String(mensaje ?? '').matchAll(p)) {
            const id = m[1].toUpperCase();
            if (!IMPRESCINDIBLES.has(id)) ids.add(id);
        }
    }
    return [...ids];
}

/** Quita de la lista de atributos los rechazados. Devuelve cuáles se quitaron de verdad. */
export function sinAtributosRechazados<T extends { id: string }>(atributos: T[], rechazados: string[]): { atributos: T[]; quitados: string[] } {
    const fuera = new Set(rechazados.map((r) => r.toUpperCase()));
    const quitados = atributos.filter((a) => fuera.has(String(a.id).toUpperCase())).map((a) => a.id);
    return { atributos: atributos.filter((a) => !fuera.has(String(a.id).toUpperCase())), quitados };
}
