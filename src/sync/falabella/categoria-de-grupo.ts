/**
 * La categoría de Falabella se guarda en CADA variante. En un grupo pueden quedar variantes sin categoría o con categorías distintas
 * (cada una se categorizó por separado). Funciones puras: el servicio las aplica sobre la base.
 */

export interface VarianteConCategoria {
    id: string;
    /** La categoría de Falabella que tiene, o null si no tiene. */
    categoria: string | null;
    /** Ya está en Falabella (publicada, pausada o enviándose): su categoría allí no se puede cambiar. */
    publicada: boolean;
}

export interface EstadoDeCategoriaDeGrupo {
    variantes: number;
    sinCategoria: string[];
    categorias: { id: string; total: number; publicadas: number }[];
    /** La que usan más variantes ya publicadas (si no hay publicadas, la más usada): es la que conviene dar a las que faltan. */
    recomendada: string | null;
    /** El grupo usa más de una categoría. */
    mezcladas: boolean;
}

export function estadoDeCategoriaDeGrupo(variantes: VarianteConCategoria[]): EstadoDeCategoriaDeGrupo {
    const cuenta = new Map<string, { total: number; publicadas: number }>();
    const sinCategoria: string[] = [];
    for (const v of variantes) {
        const c = String(v.categoria ?? '').trim();
        if (!c) { sinCategoria.push(v.id); continue; }
        const e = cuenta.get(c) ?? { total: 0, publicadas: 0 };
        e.total++;
        if (v.publicada) e.publicadas++;
        cuenta.set(c, e);
    }
    const categorias = [...cuenta.entries()].map(([id, e]) => ({ id, ...e })).sort((a, b) => b.publicadas - a.publicadas || b.total - a.total || a.id.localeCompare(b.id));
    return { variantes: variantes.length, sinCategoria, categorias, recomendada: categorias[0]?.id ?? null, mezcladas: categorias.length > 1 };
}
