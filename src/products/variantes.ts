import { BadRequestException } from '@nestjs/common';
import { EjeDeVariacion } from './entities/product-group.entity';

/** Límites para que la tabla de variantes siga siendo manejable (y los canales las acepten). */
export const MAX_EJES = 3;
export const MAX_VARIANTES = 100;
const MAX_VALORES_POR_EJE = 40;

export type ValoresDeVariante = Record<string, string>;

/** Texto sin tildes, en minúsculas y sin espacios sobrantes: para comparar valores y nombres. */
export const normalizar = (t: unknown): string =>
    String(t ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Valida y limpia los ejes: de 1 a 3, con nombre propio y sin repetir, cada uno con al menos un valor (sin repetir,
 * sin distinguir mayúsculas ni tildes). Devuelve los ejes tal como se guardarán.
 */
export function normalizarEjes(entrada: unknown): EjeDeVariacion[] {
    if (!Array.isArray(entrada) || entrada.length === 0) throw new BadRequestException('Indica en qué se diferencian las variantes (por ejemplo, Color o Talla).');
    if (entrada.length > MAX_EJES) throw new BadRequestException(`Se admiten hasta ${MAX_EJES} ejes por producto.`);

    const nombres = new Set<string>();
    return entrada.map((eje: any) => {
        const name = String(eje?.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 50);
        if (!name) throw new BadRequestException('Cada eje necesita un nombre.');
        if (nombres.has(normalizar(name))) throw new BadRequestException(`El eje "${name}" está repetido.`);
        nombres.add(normalizar(name));

        const vistos = new Set<string>();
        const values: string[] = [];
        for (const bruto of Array.isArray(eje?.values) ? eje.values : []) {
            const v = String(bruto ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
            if (!v || vistos.has(normalizar(v))) continue;
            vistos.add(normalizar(v));
            values.push(v);
        }
        if (!values.length) throw new BadRequestException(`El eje "${name}" necesita al menos un valor.`);
        if (values.length > MAX_VALORES_POR_EJE) throw new BadRequestException(`El eje "${name}" admite hasta ${MAX_VALORES_POR_EJE} valores.`);
        return { name, values };
    });
}

/** Clave estable de una combinación de valores («rojo|m»), para detectar combinaciones repetidas. */
export function claveDeCombinacion(valores: ValoresDeVariante, ejes: EjeDeVariacion[]): string {
    return ejes.map((e) => normalizar(valores[e.name])).join('|');
}

/** Etiqueta legible de una combinación («Rojo · M»). */
export function etiquetaDe(valores: ValoresDeVariante, ejes: EjeDeVariacion[]): string {
    return ejes.map((e) => valores[e.name]).join(' · ');
}

/**
 * Comprueba que una variante da un valor válido para cada eje y devuelve sus valores con la escritura oficial del eje
 * («rojo» → «Rojo»). Un valor que el eje no tiene es un error: los ejes se amplían de forma explícita.
 */
export function valoresDeVariante(crudos: unknown, ejes: EjeDeVariacion[]): ValoresDeVariante {
    const origen = (crudos ?? {}) as Record<string, unknown>;
    const delUsuario = new Map(Object.keys(origen).map((k) => [normalizar(k), origen[k]]));
    const salida: ValoresDeVariante = {};
    for (const eje of ejes) {
        const dado = delUsuario.get(normalizar(eje.name));
        const oficial = eje.values.find((v) => normalizar(v) === normalizar(dado));
        if (!oficial) throw new BadRequestException(`Falta un valor válido de "${eje.name}" en una variante${dado ? ` («${String(dado)}» no está entre los valores del eje)` : ''}.`);
        salida[eje.name] = oficial;
    }
    return salida;
}

/** Parte del SKU que representa un valor: mayúsculas y números, hasta 6 caracteres («Rojo» → «ROJO», «Hello Kitty» → «HELLOK»). */
const parte = (v: string): string =>
    v.normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 6) || 'X';

/**
 * SKU de las variantes: el escrito por el usuario se respeta; si no hay, se arma con el código del grupo y los valores
 * («MK-1-ROJO-M»). Si ya está ocupado (o lo usa otra variante del mismo lote) se añade -2, -3… hasta encontrar uno libre.
 * `ocupados` va en minúsculas y sin espacios.
 */
export function asignarSkus(
    codigoDelGrupo: string,
    variantes: { valores: ValoresDeVariante; sku?: string | null }[],
    ejes: EjeDeVariacion[],
    ocupados: Set<string>,
): string[] {
    const usados = new Set(ocupados);
    const salida: string[] = new Array(variantes.length);

    // Primero los escritos a mano: si repiten con otra variante del lote, es un error del usuario.
    variantes.forEach((v, i) => {
        const dado = (v.sku ?? '').trim();
        if (!dado) return;
        const clave = dado.toLowerCase();
        if (usados.has(clave)) throw new BadRequestException(`El SKU "${dado}" ya está en uso. Cada variante necesita un SKU distinto.`);
        usados.add(clave);
        salida[i] = dado;
    });
    variantes.forEach((v, i) => {
        if (salida[i]) return;
        const base = `${codigoDelGrupo.trim()}-${ejes.map((e) => parte(v.valores[e.name])).join('-')}`;
        let candidato = base;
        for (let n = 2; usados.has(candidato.toLowerCase()); n++) candidato = `${base}-${n}`;
        usados.add(candidato.toLowerCase());
        salida[i] = candidato;
    });
    return salida;
}

/** Todas las combinaciones posibles de los ejes (sirve para sugerir la tabla completa). */
export function combinaciones(ejes: EjeDeVariacion[]): ValoresDeVariante[] {
    return ejes.reduce<ValoresDeVariante[]>(
        (acc, eje) => acc.flatMap((a) => eje.values.map((v) => ({ ...a, [eje.name]: v }))),
        [{}],
    );
}
