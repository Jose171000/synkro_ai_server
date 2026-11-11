import { normalizar } from '../ai/ripley-atributos';
import { claseDeEje } from './compatibilidad-variantes';

/**
 * Ajustes de valores por canal: cuando un color, una talla o un tamaño que escribió la persona no existe en la lista cerrada de un canal
 * («Plomo intermedio» no está en la lista de colores de Falabella), se guarda a qué opción VÁLIDA de ese canal corresponde («Gris»).
 *
 * - Es por canal: el valor de la persona no cambia en Synkro ni en los demás canales.
 * - Es general: sirve igual para Falabella, Ripley y cualquier canal nuevo que tenga listas cerradas. Cada canal solo tiene que
 *   consultar `valorConAjuste` antes de aplicar su regla automática.
 * - Se guarda en los atributos de cada variante (`_ajustes`), sin tocar la base de datos.
 *
 * Forma: { falabella: { color: { "plomo intermedio": "Gris" } } }  →  canal → clase del dato → valor normalizado → opción del canal.
 * Funciones puras, sin red.
 */

export const CLAVE_DE_AJUSTES = '_ajustes';

export type AjustesDeCanal = Record<string, Record<string, string>>; // clase → valor normalizado → opción del canal

export interface CambioDeAjuste { clase: string; valor: string; opcion: string }

/** El mismo valor escrito con otras mayúsculas, tildes o espacios es el mismo valor. */
export const claveDeValor = (valor: unknown): string => normalizar(valor);

/** Los ajustes ya guardados para un canal (vacío si no hay). */
export function ajustesDe(atributos: Record<string, any> | null | undefined, canal: string): AjustesDeCanal {
    const todos = (atributos ?? {})[CLAVE_DE_AJUSTES];
    const delCanal = todos && typeof todos === 'object' ? todos[String(canal).toLowerCase()] : undefined;
    return delCanal && typeof delCanal === 'object' ? delCanal : {};
}

/** Los atributos con estos ajustes añadidos o actualizados para el canal. No modifica el objeto recibido. */
export function guardarAjustes(atributos: Record<string, any> | null | undefined, canal: string, cambios: CambioDeAjuste[]): Record<string, any> {
    const salida: Record<string, any> = { ...(atributos ?? {}) };
    const todos: Record<string, AjustesDeCanal> = { ...(salida[CLAVE_DE_AJUSTES] ?? {}) };
    const c = String(canal).toLowerCase();
    const delCanal: AjustesDeCanal = Object.fromEntries(Object.entries(todos[c] ?? {}).map(([clase, m]) => [clase, { ...m }]));
    for (const { clase, valor, opcion } of cambios) {
        const k = claveDeValor(valor);
        if (!clase || !k || !String(opcion ?? '').trim()) continue;
        (delCanal[clase] ??= {})[k] = String(opcion).trim();
    }
    todos[c] = delCanal;
    salida[CLAVE_DE_AJUSTES] = todos;
    return salida;
}

/** La opción de la lista escrita tal cual la tiene el canal (ignora mayúsculas y tildes), o null si no está en la lista. */
export function opcionDeLaLista(opcion: unknown, opciones: string[]): string | null {
    const k = claveDeValor(opcion);
    if (!k) return null;
    return (opciones ?? []).find((o) => claveDeValor(o) === k) ?? null;
}

/**
 * La opción del canal para un valor: primero el ajuste que la persona confirmó (si sigue siendo una opción válida de la lista);
 * si no, la regla automática del canal. `atributo` es el nombre del dato del canal («Color básico variant»): de él sale la clase (color, talla…).
 */
export function valorConAjuste(args: {
    canal: string;
    atributos: Record<string, any> | null | undefined;
    atributo: string;
    valor: string;
    opciones: string[];
    automatico: (valor: string, opciones: string[]) => string | null | undefined;
}): string | undefined {
    const { canal, atributos, atributo, valor, opciones, automatico } = args;
    const guardado = ajustesDe(atributos, canal)[claseDeEje(atributo)]?.[claveDeValor(valor)];
    const valido = guardado ? opcionDeLaLista(guardado, opciones) : null;
    if (valido) return valido;
    return automatico(valor, opciones) ?? undefined;
}

/** Los ajustes de un canal de todas las variantes de un grupo juntos (cada variante guarda los del grupo; si difieren, el último gana). */
export function unirAjustes(listaDeAtributos: Array<Record<string, any> | null | undefined>, canal: string): AjustesDeCanal {
    const salida: AjustesDeCanal = {};
    for (const attrs of listaDeAtributos) {
        for (const [clase, valores] of Object.entries(ajustesDe(attrs, canal))) salida[clase] = { ...(salida[clase] ?? {}), ...valores };
    }
    return salida;
}
