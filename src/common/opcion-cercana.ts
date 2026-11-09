const normalizar = (t: string) => t.trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const palabras = (t: string) => normalizar(t).split(/[^a-z0-9ñ]+/).filter((p) => p.length > 2);

/**
 * Nombres de color de uso común que los canales casi nunca tienen como opción, y con qué otros nombres se suelen listar (en orden de
 * preferencia). Solo se usan cuando ninguna opción se parece al valor: «Vino» no existe en la lista de Falabella, pero «Burdeos» sí.
 * Las claves van sin tildes y en minúscula.
 */
const EQUIVALENCIAS_DE_COLOR: Record<string, string[]> = {
    vino: ['burdeos', 'burdeo', 'borgona caoba', 'bordo', 'granate'],
    guinda: ['burdeos', 'burdeo', 'borgona caoba', 'granate', 'bordo'],
    granate: ['granate', 'burdeos', 'burdeo', 'borgona caoba'],
    bordo: ['burdeos', 'burdeo', 'borgona caoba', 'granate'],
    burgundy: ['burdeos', 'burdeo', 'borgona caoba'],
    rosado: ['rosado', 'rosa', 'rosa fuerte'],
    rosa: ['rosado', 'rosa'],
    marron: ['marron', 'cafe', 'chocolate'],
    cafe: ['cafe', 'marron', 'chocolate'],
    chocolate: ['chocolate', 'cafe', 'marron'],
    crema: ['crema', 'beige'],
    hueso: ['hueso', 'crema', 'beige', 'blanco'],
    marfil: ['marfil', 'crema', 'beige', 'blanco'],
    nude: ['nude', 'beige', 'crema'],
    plomo: ['plomo', 'gris'],
    celeste: ['celeste', 'azul'],
    plateado: ['plateado', 'plata'],
    dorado: ['dorado', 'oro'],
    mostaza: ['mostaza', 'amarillo'],
    lila: ['lila', 'violeta', 'morado'],
    turquesa: ['turquesa', 'celeste', 'azul'],
};

function equivalenciaDeColor(valor: string, opciones: string[]): string | undefined {
    const buscado = normalizar(valor);
    const claves = [buscado, ...palabras(valor).filter((p) => p.length >= 4)].filter((k) => EQUIVALENCIAS_DE_COLOR[k]);
    for (const clave of claves) {
        for (const candidato of EQUIVALENCIAS_DE_COLOR[clave]) {
            const opcion = opciones.find((o) => normalizar(o) === candidato);
            if (opcion) return opcion;
        }
    }
    return undefined;
}

/**
 * La opción de una lista cerrada que mejor corresponde a un valor escrito libremente
 * («madera de pino» → «Madera»). Devuelve la opción tal como la escribe el canal, o undefined si ninguna se parece.
 */
export function opcionCercana(valor: string, opciones: string[]): string | undefined {
    const buscado = normalizar(valor);
    if (!buscado || !opciones?.length) return undefined;

    const normalizadas = opciones.map((o) => ({ original: o, k: normalizar(o) }));

    const exacta = normalizadas.find((o) => o.k === buscado);
    if (exacta) return exacta.original;

    // Una contiene a la otra («madera de pino» contiene «madera»): la de longitud más parecida.
    const contenidas = normalizadas
        .filter((o) => o.k.length >= 3 && (buscado.includes(o.k) || o.k.includes(buscado)))
        .sort((a, b) => Math.abs(a.k.length - buscado.length) - Math.abs(b.k.length - buscado.length));
    if (contenidas.length) return contenidas[0].original;

    // Palabras en común.
    const mias = new Set(palabras(valor));
    if (!mias.size) return undefined;
    let mejor: { original: string; puntaje: number } | undefined;
    for (const o of normalizadas) {
        const suyas = new Set(palabras(o.original));
        if (!suyas.size) continue;
        const comunes = [...mias].filter((p) => suyas.has(p)).length;
        const puntaje = comunes / Math.min(mias.size, suyas.size);
        if (puntaje >= 0.5 && (!mejor || puntaje > mejor.puntaje)) mejor = { original: o.original, puntaje };
    }
    // Último recurso: un nombre de color de uso común («Vino») que la lista escribe de otra forma («Burdeos»).
    return mejor?.original ?? equivalenciaDeColor(valor, opciones);
}
