/**
 * Regeneración con IA «solo lo vacío»: después de que la IA genera el contenido de un producto, se vuelve a poner lo que
 * ya tenía valor (título, descripción, palabras clave, ficha HTML, lo visto en las fotos). Los atributos ya se combinan sin
 * pisar lo existente; aquí solo se cuenta qué se llenó, para decírselo a la persona producto por producto.
 */

export interface ContenidoDeIA {
    aiTitle?: string | null;
    aiDescription?: string | null;
    aiKeywords?: unknown;
    aiAttributes?: Record<string, any> | null;
}

const vacio = (v: any): boolean =>
    v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
const esObjeto = (v: any) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Claves internas o rehechas aparte: no cuentan como «atributos llenados». */
const NO_CUENTAN = new Set(['descriptionHtml', 'vision', 'estimated', 'ripley', 'brand_source']);

/** Cuántos atributos pasaron de vacíos a llenos (recorre los grupos de atributos de cada canal). */
export function atributosLlenados(antes: Record<string, any> | null | undefined, despues: Record<string, any> | null | undefined): number {
    let n = 0;
    for (const [clave, nuevo] of Object.entries(despues ?? {})) {
        if (clave.startsWith('_') || NO_CUENTAN.has(clave)) continue;
        const previo = (antes ?? {})[clave];
        if (esObjeto(nuevo)) n += atributosLlenados(esObjeto(previo) ? previo : {}, nuevo);
        else if (vacio(previo) && !vacio(nuevo)) n++;
    }
    return n;
}

const REHECHOS = ['aiTitle', 'aiDescription', 'descriptionHtml'];

/**
 * `antes`: el producto tal como estaba. `despues`: como quedó tras aplicar a la IA (ya con los atributos combinados).
 * Devuelve el contenido final (lo que estaba lleno se conserva) y la lista de lo que se llenó.
 */
export function soloLoVacio(
    antes: ContenidoDeIA,
    despues: ContenidoDeIA,
): { final: { aiTitle: string | null; aiDescription: string | null; aiKeywords: unknown; aiAttributes: Record<string, any> }; llenado: string[] } {
    const llenado: string[] = [];
    const attrsAntes = { ...(antes.aiAttributes ?? {}) };
    const attrs = { ...(despues.aiAttributes ?? {}) };
    const marcasAntes: string[] = Array.isArray(attrsAntes._ia) ? attrsAntes._ia : [];
    const marcas: string[] = Array.isArray(attrs._ia) ? [...attrs._ia] : [];
    // Un campo que ya estaba lleno se queda como estaba y no se marca como hecho por la IA.
    const conservar = (campo: string) => {
        const i = marcas.indexOf(campo);
        if (i >= 0) marcas.splice(i, 1);
        if (marcasAntes.includes(campo) && !marcas.includes(campo)) marcas.push(campo);
    };

    let aiTitle = despues.aiTitle ?? null;
    if (!vacio(antes.aiTitle)) { aiTitle = antes.aiTitle!; conservar('aiTitle'); } else if (!vacio(aiTitle)) llenado.push('título');

    let aiDescription = despues.aiDescription ?? null;
    if (!vacio(antes.aiDescription)) { aiDescription = antes.aiDescription!; conservar('aiDescription'); } else if (!vacio(aiDescription)) llenado.push('descripción');

    let aiKeywords: unknown = despues.aiKeywords ?? null;
    if (!vacio(antes.aiKeywords)) aiKeywords = antes.aiKeywords; else if (!vacio(aiKeywords)) llenado.push('puntos clave');

    if (!vacio(attrsAntes.descriptionHtml)) { attrs.descriptionHtml = attrsAntes.descriptionHtml; conservar('descriptionHtml'); } else if (!vacio(attrs.descriptionHtml)) llenado.push('ficha HTML');

    // Lo que la IA vio en las fotos: si ya había una lectura, se conserva con la huella de las fotos que le corresponde.
    if (!vacio(attrsAntes.vision)) {
        attrs.vision = attrsAntes.vision;
        if (attrsAntes._visionFotos !== undefined) attrs._visionFotos = attrsAntes._visionFotos; else delete attrs._visionFotos;
    }

    const n = atributosLlenados(attrsAntes, attrs);
    if (n > 0) llenado.push(n === 1 ? '1 atributo' : `${n} atributos`);

    attrs._ia = [...new Set(marcas.filter((c) => !REHECHOS.includes(c) || marcas.includes(c)))];
    return { final: { aiTitle, aiDescription, aiKeywords, aiAttributes: attrs }, llenado };
}
