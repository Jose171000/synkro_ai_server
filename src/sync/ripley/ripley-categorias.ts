/**
 * Convierte lo que Ripley (Mirakl) publica sobre su catálogo (jerarquías H11, atributos PM11, listas de valores VL11) en lo que
 * Synkro guarda: las categorías donde SÍ se puede publicar (las hojas del árbol), con su ruta completa y sus atributos.
 * Son funciones puras, sin red: lo que llega de la API se prueba con datos de ejemplo.
 */

export interface JerarquiaRipley { code?: string; label?: string; level?: number; parent_code?: string | null }
export interface AtributoRipley {
    code?: string; label?: string; type?: string; type_parameter?: string | null; hierarchy_code?: string;
    required?: boolean; requirement_level?: string; variant?: boolean; description?: string | null; example?: string | null;
}
export interface ListaRipley { code?: string; label?: string; values?: { code?: string; label?: string }[] }

export interface CategoriaDeRipley {
    codigo: string;
    nombre: string;
    /** Ruta completa, «MALETERÍA, BOLSOS Y CARTERAS › LONCHERAS» */
    ruta: string;
}

/** Atributo como se guarda en `marketplace_categories.requiredAttributes` (ampliado con lo propio de Ripley). */
export interface AtributoGuardado {
    name: string;
    description: string;
    example: string;
    isRequired: boolean;
    options?: string[];
    valueType?: string;
    /** Código de la lista cerrada de Ripley (los valores se guardan una sola vez en `marketplace_value_lists`). */
    listCode?: string;
    /** El atributo define la variante (en Ripley, el color). */
    isVariant?: boolean;
    /** REQUIRED / RECOMMENDED / OPTIONAL según Ripley. */
    level?: string;
}

/** Hasta este tamaño una lista va también dentro del atributo; más grande (tipo de producto, colores) solo se referencia. */
export const MAX_OPCIONES_EN_LINEA = 40;

/** Las hojas del árbol: una categoría que no es padre de ninguna otra. Solo en ellas se publica. */
export function hojasDeRipley(jerarquias: JerarquiaRipley[]): CategoriaDeRipley[] {
    const validas = (jerarquias ?? []).filter((h) => h?.code && h?.label);
    const porCodigo = new Map(validas.map((h) => [String(h.code), h]));
    const padres = new Set(validas.map((h) => String(h.parent_code ?? '')).filter(Boolean));
    const rutaDe = (h: JerarquiaRipley): string => {
        const partes: string[] = [];
        const vistos = new Set<string>();
        let actual: JerarquiaRipley | undefined = h;
        while (actual && !vistos.has(String(actual.code))) {
            vistos.add(String(actual.code));
            partes.unshift(String(actual.label).trim());
            actual = actual.parent_code ? porCodigo.get(String(actual.parent_code)) : undefined;
        }
        return partes.join(' › ');
    };
    return validas
        .filter((h) => !padres.has(String(h.code)))
        .map((h) => ({ codigo: String(h.code), nombre: String(h.label).trim(), ruta: rutaDe(h) }));
}

/** Agrupa los atributos por categoría. */
export function atributosPorCategoria(atributos: AtributoRipley[]): Map<string, AtributoRipley[]> {
    const mapa = new Map<string, AtributoRipley[]>();
    for (const a of atributos ?? []) {
        if (!a?.code || !a?.hierarchy_code) continue;
        const lista = mapa.get(String(a.hierarchy_code)) ?? [];
        lista.push(a);
        mapa.set(String(a.hierarchy_code), lista);
    }
    return mapa;
}

const ORDEN_DE_NIVEL: Record<string, number> = { REQUIRED: 0, RECOMMENDED: 1, OPTIONAL: 2 };

/** Los atributos de una categoría tal como se guardan: obligatorios primero, con su lista de valores si es corta. */
export function atributosParaGuardar(atributos: AtributoRipley[], listas: Map<string, string[]>): AtributoGuardado[] {
    return [...(atributos ?? [])]
        .map((a): AtributoGuardado => {
            const codigoDeLista = typeof a.type_parameter === 'string' && a.type_parameter ? a.type_parameter : undefined;
            const valores = codigoDeLista ? listas.get(codigoDeLista) : undefined;
            const nivel = String(a.requirement_level ?? (a.required ? 'REQUIRED' : 'OPTIONAL')).toUpperCase();
            return {
                name: String(a.code),
                description: [a.label, a.description].filter((t) => typeof t === 'string' && t.trim()).join(' — ').slice(0, 300),
                example: String(a.example ?? valores?.[0] ?? ''),
                isRequired: a.required === true || nivel === 'REQUIRED',
                ...(valores && valores.length > 0 && valores.length <= MAX_OPCIONES_EN_LINEA ? { options: valores } : {}),
                valueType: String(a.type ?? '').toLowerCase() || undefined,
                ...(codigoDeLista && a.type === 'LIST' ? { listCode: codigoDeLista } : {}),
                ...(a.variant === true ? { isVariant: true } : {}),
                level: nivel,
            };
        })
        .sort((x, y) => (ORDEN_DE_NIVEL[x.level ?? 'OPTIONAL'] ?? 3) - (ORDEN_DE_NIVEL[y.level ?? 'OPTIONAL'] ?? 3) || x.name.localeCompare(y.name));
}

/** Pasa las listas de Ripley a «código de lista → valores» (se usa la etiqueta, que es lo que Ripley pide en el archivo). */
export function listasDeValores(listas: ListaRipley[]): Map<string, string[]> {
    const mapa = new Map<string, string[]>();
    for (const l of listas ?? []) {
        if (!l?.code) continue;
        const valores = (l.values ?? []).map((v) => String(v?.label ?? v?.code ?? '').trim()).filter(Boolean);
        mapa.set(String(l.code), [...new Set(valores)]);
    }
    return mapa;
}

/** Texto que se convierte en vector para que la IA encuentre la categoría por parecido (la ruta completa orienta mejor que el nombre). */
export function textoParaVector(c: CategoriaDeRipley): string {
    return c.ruta.replace(/[›|]/g, ' ').replace(/\s+/g, ' ').trim() || c.nombre;
}
