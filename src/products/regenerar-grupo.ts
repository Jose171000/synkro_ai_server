import { combinarAtributos } from '../ai/combinar-atributos';
import { huellaDeFotos } from '../ai/vision-fotos';
import { claveDeAtributo } from '../sync/falabella/falabella-fields';

/** Lo que es propio de cada variante (color, talla y los ejes del grupo): la IA no lo reparte, cada variante conserva el suyo. */
export function esAtributoDeEje(clave: string, ejes: { name: string }[]): boolean {
    const propios = new Set(['color', 'colorbasico', 'maincolor', 'talla', 'size', ...ejes.map((e) => claveDeAtributo(e.name))]);
    return propios.has(claveDeAtributo(clave));
}

export function sinAtributosDeEje(attrs: Record<string, any> | null | undefined, ejes: { name: string }[]): Record<string, any> {
    return Object.fromEntries(Object.entries(attrs ?? {}).filter(([k]) => !esAtributoDeEje(k, ejes)));
}

const REHECHOS = ['aiTitle', 'aiDescription', 'descriptionHtml'];

/**
 * Atributos de UNA variante después de regenerar el contenido del grupo con IA. Misma regla que al regenerar un producto suelto:
 * no se borra lo que la variante ya tenía (marca, atributos revisados, su color y su talla); la IA rellena lo vacío y se rehacen
 * la ficha HTML y lo que se ve en las fotos. `delGrupo` son los atributos que devolvió la IA, ya sin los de los ejes.
 */
export function atributosTrasRegenerar(
    previos: Record<string, any> | null | undefined,
    delGrupo: Record<string, any>,
    contenido: { htmlDescription?: string | null; vision?: any },
    fotos: string[],
): Record<string, any> {
    const anteriores = { ...(previos ?? {}) };
    const marcasNuevas: string[] = Array.isArray(delGrupo._ia) ? delGrupo._ia : [];
    const combinados = combinarAtributos(anteriores, delGrupo);
    const marcasPrevias: string[] = Array.isArray(anteriores._ia) ? anteriores._ia : [];
    const marcaVigente = String(anteriores.brand ?? '').trim() ? marcasPrevias.includes('brand') : marcasNuevas.includes('brand');
    combinados._ia = [...new Set([
        ...marcasPrevias.filter((c) => !REHECHOS.includes(c) && c !== 'brand'),
        ...marcasNuevas.filter((c) => REHECHOS.includes(c)),
        ...(marcaVigente ? ['brand'] : []),
    ])];
    if (contenido.htmlDescription) combinados.descriptionHtml = contenido.htmlDescription;
    if (contenido.vision) {
        combinados.vision = contenido.vision;
        combinados._visionFotos = huellaDeFotos(fotos);
    }
    return combinados;
}
