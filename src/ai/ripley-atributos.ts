import type { CategoryAttribute } from '../categories/entities/marketplace-category.entity';

/**
 * Los atributos de Ripley con lista cerrada (color, tipo de producto, Sí/No…) solo aceptan EXACTAMENTE uno de sus valores.
 * La IA escribe texto libre («Marrón oscuro», «lonchera»): aquí se lleva cada valor a uno de la lista, o se descarta si no hay
 * equivalente (así el dato queda como «falta» en vez de mandar algo que Ripley rechazaría). Funciones puras, sin red.
 */

export const normalizar = (t: unknown): string =>
    String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñ]+/g, ' ').trim();

/** «loncheras» y «lonchera» son la misma palabra: se compara sin la terminación de plural. */
const raiz = (palabra: string): string => (palabra.length > 3 ? palabra.replace(/(es|s)$/, '') : palabra);
const raices = (t: unknown): string[] => normalizar(t).split(' ').filter(Boolean).map(raiz);
const clave = (t: unknown): string => raices(t).join(' ');

const SI = new Set(['si', 'yes', 'true', 'verdadero', '1']);
const NO = new Set(['no', 'false', 'falso', '0']);

/** Lleva un valor a uno EXACTO de la lista, o devuelve null si no hay equivalente claro. */
export function ajustarAUnaLista(valor: unknown, valores: string[]): string | null {
    const texto = String(valor ?? '').trim();
    if (!texto || !valores?.length) return null;
    const porClave = new Map<string, string>();
    for (const v of valores) if (!porClave.has(clave(v))) porClave.set(clave(v), v);

    // Listas de Sí / No: acepta «sí», «Si», «yes», «true»…
    if (porClave.has('si') && porClave.has('no') && valores.length <= 3) {
        const n = normalizar(texto);
        if (SI.has(n)) return porClave.get('si')!;
        if (NO.has(n)) return porClave.get('no')!;
    }

    const k = clave(texto);
    if (porClave.has(k)) return porClave.get(k)!;

    // «Marrón oscuro» → «Marrón»: el valor más largo de la lista que aparece como palabras completas dentro del texto.
    const palabrasDelTexto = ` ${k} `;
    const contenidos = [...porClave.entries()].filter(([c]) => c.length >= 3 && palabrasDelTexto.includes(` ${c} `));
    if (contenidos.length) return contenidos.sort((a, b) => b[0].length - a[0].length)[0][1];

    // «marron» → «Marrón Claro» solo si es la única opción que lo contiene (si hay varias, no se adivina).
    if (k.length >= 4) {
        const queLoContienen = [...porClave.entries()].filter(([c]) => ` ${c} `.includes(` ${k} `));
        if (queLoContienen.length === 1) return queLoContienen[0][1];
    }
    return null;
}

/**
 * Los valores de una lista larga que más se parecen a las palabras del producto, para ofrecérselos a la IA como opciones
 * (una lista de 2.187 tipos de producto no cabe en el prompt, pero 40 candidatos sí).
 */
export function candidatosDeLista(valores: string[], textos: Array<string | null | undefined>, max = 40): string[] {
    const palabras = new Set(textos.flatMap((t) => raices(t)).filter((p) => p.length >= 3));
    if (!palabras.size) return [];
    return (valores ?? [])
        .map((v) => {
            const rs = raices(v);
            const aciertos = rs.filter((r) => palabras.has(r)).length;
            return { v, aciertos, puntaje: aciertos / Math.max(rs.length, 1) };
        })
        .filter((x) => x.aciertos > 0)
        .sort((a, b) => b.puntaje - a.puntaje || b.aciertos - a.aciertos || a.v.length - b.v.length)
        .slice(0, max)
        .map((x) => x.v);
}

/** Hasta este tamaño la lista completa va al prompt; más grande solo se ofrecen candidatos. */
export const MAX_LISTA_EN_PROMPT = 300;

/**
 * Pone las opciones que la IA debe ver: la lista completa si es corta, o los candidatos más parecidos al producto si es larga.
 * Los atributos que no tienen lista cerrada quedan igual.
 */
export function conOpcionesParaLaIa(
    atributos: CategoryAttribute[],
    listas: Map<string, string[]>,
    textosDelProducto: Array<string | null | undefined>,
): CategoryAttribute[] {
    return (atributos ?? []).map((a) => {
        const lista = a.listCode ? listas.get(a.listCode) : undefined;
        if (!lista?.length) return a;
        if (lista.length <= MAX_LISTA_EN_PROMPT) return { ...a, options: lista };
        const candidatos = candidatosDeLista(lista, textosDelProducto, 40);
        return candidatos.length ? { ...a, options: candidatos } : a;
    });
}

/**
 * Lleva los valores que escribió la IA a los de las listas de Ripley. Lo que no tiene equivalente se quita (y se informa en
 * `invalidos`) para que quede como dato faltante en vez de salir hacia Ripley con un valor que rechazaría.
 */
export function ajustarAtributosDeRipley(
    atributos: Record<string, any> | null | undefined,
    requisitos: CategoryAttribute[],
    listas: Map<string, string[]>,
): { atributos: Record<string, any>; ajustados: Record<string, { de: string; a: string }>; invalidos: string[] } {
    const salida: Record<string, any> = { ...(atributos ?? {}) };
    const ajustados: Record<string, { de: string; a: string }> = {};
    const invalidos: string[] = [];
    for (const req of requisitos ?? []) {
        const lista = (req.listCode ? listas.get(req.listCode) : undefined) ?? req.options;
        if (!lista?.length) continue;
        const actual = salida[req.name];
        if (actual === null || actual === undefined || String(actual).trim() === '') continue;
        const ajustado = ajustarAUnaLista(actual, lista);
        if (ajustado === null) {
            delete salida[req.name];
            invalidos.push(req.name);
        } else {
            if (ajustado !== String(actual)) ajustados[req.name] = { de: String(actual), a: ajustado };
            salida[req.name] = ajustado;
        }
    }
    return { atributos: salida, ajustados, invalidos };
}
