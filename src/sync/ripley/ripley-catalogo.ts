import type { CategoryAttribute } from '../../categories/entities/marketplace-category.entity';
import { ajustarAtributosDeRipley } from '../../ai/ripley-atributos';

/**
 * Lo que la pantalla de Ripley necesita saber de una categoría guardada: los campos a dibujar y la validación de lo que se escribe.
 * Funciones puras, sin base de datos ni red.
 */

/** Hasta este tamaño la lista va completa dentro del campo; más grande (tipo de producto: 2.187) se busca por texto. */
export const MAX_LISTA_EN_CAMPO = 300;

export interface CampoDeRipley {
    name: string;
    /** Nombre legible del atributo (lo primero de la descripción que guardó la importación). */
    label: string;
    description: string;
    required: boolean;
    level: string;
    isVariant: boolean;
    /** text | list | … según Ripley */
    type: string;
    listCode: string | null;
    /** Valores permitidos, si la lista es corta. */
    options?: string[];
    /** La lista es larga: no se manda entera, se busca con `valores`. */
    listaLarga?: boolean;
}

/** Los campos de una categoría, en el orden en que se guardaron (obligatorios primero). */
export function camposDeCategoria(atributos: CategoryAttribute[] | null | undefined, listas: Map<string, string[]>): CampoDeRipley[] {
    return (atributos ?? []).map((a) => {
        const valores = a.listCode ? listas.get(a.listCode) : undefined;
        const corta = !!valores?.length && valores.length <= MAX_LISTA_EN_CAMPO;
        return {
            name: a.name,
            label: String(a.description ?? '').split(' — ')[0] || a.name,
            description: a.description ?? '',
            required: !!a.isRequired,
            level: a.level ?? (a.isRequired ? 'REQUIRED' : 'OPTIONAL'),
            isVariant: !!a.isVariant,
            type: (a.valueType ?? 'text').toLowerCase(),
            listCode: a.listCode ?? null,
            ...(corta ? { options: valores } : a.options?.length ? { options: a.options } : {}),
            ...(valores && !corta ? { listaLarga: true } : {}),
        };
    });
}

/** ¿Esta categoría permite agrupar variantes? Solo si algún atributo suyo define la variante. */
export function ejesDeVariante(atributos: CategoryAttribute[] | null | undefined): string[] {
    return (atributos ?? []).filter((a) => a.isVariant).map((a) => a.name);
}

/**
 * Valida lo que escribió la persona contra la categoría: los valores de lista se llevan a la escritura exacta de Ripley y los que
 * no existen se rechazan (con el nombre del campo). Los campos vacíos se ignoran (borrar un valor es válido).
 */
export function validarAtributosEscritos(
    escritos: Record<string, any> | null | undefined,
    atributos: CategoryAttribute[] | null | undefined,
    listas: Map<string, string[]>,
): { atributos: Record<string, string>; errores: { campo: string; motivo: string }[] } {
    const definidos = new Map((atributos ?? []).map((a) => [a.name, a]));
    const errores: { campo: string; motivo: string }[] = [];
    const conocidos: Record<string, any> = {};
    for (const [campo, valor] of Object.entries(escritos ?? {})) {
        if (!definidos.has(campo)) { errores.push({ campo, motivo: 'esta categoría de Ripley no tiene ese campo' }); continue; }
        if (valor === null || valor === undefined || String(valor).trim() === '') continue;
        conocidos[campo] = String(valor).trim();
    }
    const r = ajustarAtributosDeRipley(conocidos, [...definidos.values()], listas);
    for (const campo of r.invalidos) errores.push({ campo, motivo: 'ese valor no está en la lista de Ripley' });
    return { atributos: Object.fromEntries(Object.entries(r.atributos).map(([k, v]) => [k, String(v)])), errores };
}
