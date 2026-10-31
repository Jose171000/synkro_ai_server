import { claveDeAtributo } from './falabella/falabella-fields';

/**
 * De dónde viene cada dato de la ficha de un producto, para mostrarlo con una etiqueta:
 *  - `canal`: es lo que el canal ya tenía al importar (se calcula comparando con la copia de referencia aiAttributes._importado,
 *    así que si la persona lo cambia a mano deja de contar como del canal);
 *  - `ia`: lo escribió la IA (se anota en aiAttributes._ia al escribirlo y se quita en cuanto la persona lo edita; en los atributos
 *    se usa la lista de «estimados» que ya existía).
 * Un dato sin etiqueta es de la persona, o de antes de que se llevara esta cuenta.
 */

export type Origen = 'ia' | 'canal';
export type CampoGeneral = 'aiTitle' | 'aiDescription' | 'descriptionHtml' | 'brand';

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
const lleno = (v: unknown) => String(v ?? '').trim() !== '';
const lista = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** Anota que la IA escribió estos campos. No modifica lo que recibe. */
export function marcarComoIA(attrs: Record<string, any> | null | undefined, campos: CampoGeneral[]): Record<string, any> {
    const salida: Record<string, any> = { ...(attrs ?? {}) };
    if (campos.length) salida._ia = [...new Set([...lista(salida._ia), ...campos])];
    return salida;
}

/** Quita la anotación de «escrito por la IA» de estos campos (la persona los editó). No modifica lo que recibe. */
export function quitarMarcaIA(attrs: Record<string, any> | null | undefined, campos: CampoGeneral[]): Record<string, any> {
    const salida: Record<string, any> = { ...(attrs ?? {}) };
    if (Array.isArray(salida._ia)) salida._ia = lista(salida._ia).filter((c) => !campos.includes(c as CampoGeneral));
    return salida;
}

/** Origen de los campos generales del producto. */
export function origenesGenerales(
    producto: { aiTitle?: string | null; aiDescription?: string | null },
    attrs: Record<string, any> | null | undefined,
): Partial<Record<CampoGeneral, Origen>> {
    const a = attrs ?? {};
    const importados: any[] = Object.values(a._importado ?? {});
    const hechoPorIA = new Set(lista(a._ia));
    const salida: Partial<Record<CampoGeneral, Origen>> = {};

    const decide = (campo: CampoGeneral, valor: unknown, esDelCanal: boolean) => {
        if (!lleno(valor)) return;
        if (esDelCanal) salida[campo] = 'canal';
        else if (hechoPorIA.has(campo)) salida[campo] = 'ia';
    };

    decide('aiTitle', producto.aiTitle, false);
    decide('aiDescription', producto.aiDescription, importados.some((i) => lleno(i?.description) && norm(i.description) === norm(producto.aiDescription)));
    decide('descriptionHtml', a.descriptionHtml, importados.some((i) => lleno(i?.description) && norm(i.description) === norm(a.descriptionHtml)));
    decide('brand', a.brand, importados.some((i) => lleno(i?.brand) && norm(i.brand) === norm(a.brand)));
    return salida;
}

/** Origen de un atributo de un canal (Falabella: por nombre; Mercado Libre: por id) según su valor actual. */
export function origenDeAtributo(attrs: Record<string, any> | null | undefined, canal: 'falabella' | 'mercadolibre', nombre: string, valor: unknown): Origen | undefined {
    if (!lleno(valor)) return undefined;
    const a = attrs ?? {};
    const clave = canal === 'falabella' ? claveDeAtributo : (x: string) => x;

    const importados: Record<string, unknown> = a._importado?.[canal]?.attributes ?? {};
    const delCanal = Object.entries(importados).some(([k, v]) => clave(k) === clave(nombre) && norm(v) === norm(valor));
    if (delCanal) return 'canal';

    const estimados = lista(a.estimated?.attributes?.[canal]);
    return estimados.some((e) => clave(e) === clave(nombre)) ? 'ia' : undefined;
}

/** La persona editó un atributo: deja de ser «estimado por la IA». No modifica lo que recibe. */
export function quitarEstimado(attrs: Record<string, any>, canal: 'falabella' | 'mercadolibre', nombres: string[]): Record<string, any> {
    const estimados = attrs.estimated?.attributes?.[canal];
    if (!Array.isArray(estimados) || !nombres.length) return attrs;
    const clave = canal === 'falabella' ? claveDeAtributo : (x: string) => x;
    const quitar = new Set(nombres.map(clave));
    return {
        ...attrs,
        estimated: { ...attrs.estimated, attributes: { ...attrs.estimated.attributes, [canal]: estimados.filter((e: string) => !quitar.has(clave(e))) } },
    };
}
