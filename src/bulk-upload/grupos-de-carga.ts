import { EjeDeVariacion } from '../products/entities/product-group.entity';
import { claveDeCombinacion, MAX_VARIANTES, normalizar, normalizarEjes, valoresDeVariante, ValoresDeVariante } from '../products/variantes';

/**
 * Carga masiva de productos con variantes. Cada fila es una variante que se vende (SKU, precio, stock, fotos); las filas con
 * el mismo `sku_padre` forman UN producto con variantes, y `eje_N` / `valor_N` dicen en qué se diferencian (Medida: 2 plazas).
 * Solo funciones puras: el controlador sube las fotos y encola.
 */

/** Lo que este módulo necesita de una fila ya leída (`i` es el índice de la fila de datos: la fila del Excel es i + 2). */
export interface FilaConEjes {
    i: number;
    grupo: string;
    sku: string;
    /** Siempre 3 posiciones (eje_1..eje_3), vacías si la fila no las trae. */
    ejes: { nombre: string; valor: string }[];
}

export interface GrupoDeCarga<F extends FilaConEjes> {
    /** Código del grupo tal como se escribió (en Falabella es el ParentSku). */
    codigo: string;
    filas: F[];
    ejes: EjeDeVariacion[];
    /** Valores de cada fila, en el mismo orden que `filas`. */
    valores: ValoresDeVariante[];
}

export interface ErrorDeGrupo {
    codigo: string;
    /** Índices de todas las filas del grupo: el grupo entero queda fuera. */
    filas: number[];
    motivo: string;
}

const filaDelExcel = (i: number) => i + 2;
const clave = (codigo: string) => codigo.trim().toLowerCase();

/** ¿La fila trae algún eje o valor escrito? */
export function tieneEjes(fila: Pick<FilaConEjes, 'ejes'>): boolean {
    return fila.ejes.some((e) => e.nombre.trim() || e.valor.trim());
}

/** Códigos de `sku_padre` (en minúsculas) que tienen ejes en alguna de sus filas: esos grupos se crean como producto con variantes. */
export function codigosConVariantes(filas: Pick<FilaConEjes, 'grupo' | 'ejes'>[]): Set<string> {
    return new Set(filas.filter((f) => f.grupo.trim() && tieneEjes(f)).map((f) => clave(f.grupo)));
}

/**
 * Reparte las filas: las que tienen `sku_padre` con ejes forman grupos de variantes; las demás siguen como productos sueltos
 * (un `sku_padre` sin ejes conserva lo de antes: solo comparten la categoría). Un grupo con cualquier error queda fuera entero,
 * con un motivo que nombra las filas del Excel.
 *
 * Reglas del Excel:
 *  - El nombre de cada eje basta escribirlo en la primera fila del grupo; las demás lo heredan (si lo repiten, debe coincidir).
 *  - Cada fila del grupo necesita un valor para cada eje, y dos filas no pueden repetir la misma combinación.
 *  - Hasta 3 ejes, 40 valores por eje y 100 variantes por grupo (los mismos límites de la app).
 */
export function armarGrupos<F extends FilaConEjes>(filas: F[]): { grupos: GrupoDeCarga<F>[]; sueltas: F[]; errores: ErrorDeGrupo[] } {
    const conVariantes = codigosConVariantes(filas);
    const sueltas: F[] = [];
    const porCodigo = new Map<string, F[]>();
    for (const f of filas) {
        const c = clave(f.grupo);
        if (!c || !conVariantes.has(c)) { sueltas.push(f); continue; }
        (porCodigo.get(c) ?? porCodigo.set(c, []).get(c)!).push(f);
    }

    const grupos: GrupoDeCarga<F>[] = [];
    const errores: ErrorDeGrupo[] = [];
    for (const miembros of porCodigo.values()) {
        const codigo = miembros[0].grupo.trim();
        try {
            grupos.push({ codigo, filas: miembros, ...ejesYValores(codigo, miembros) });
        } catch (error: any) {
            errores.push({ codigo, filas: miembros.map((f) => f.i), motivo: String(error?.response?.message ?? error?.message ?? error) });
        }
    }
    return { grupos, sueltas, errores };
}

function ejesYValores(codigo: string, filas: FilaConEjes[]): { ejes: EjeDeVariacion[]; valores: ValoresDeVariante[] } {
    if (filas.length > MAX_VARIANTES) throw new Error(`el grupo ${codigo} tiene ${filas.length} filas y admite hasta ${MAX_VARIANTES} variantes`);

    // El nombre de cada eje: el primero escrito en el grupo. Si otra fila lo escribe distinto, es un error (no se adivina).
    const nombres: { nombre: string; fila: number }[] = [];
    for (let k = 0; k < 3; k++) {
        const primera = filas.find((f) => f.ejes[k]?.nombre.trim());
        if (primera) nombres[k] = { nombre: primera.ejes[k].nombre.trim(), fila: primera.i };
    }
    for (const f of filas) {
        for (let k = 0; k < 3; k++) {
            const { nombre, valor } = f.ejes[k] ?? { nombre: '', valor: '' };
            const delGrupo = nombres[k];
            if (nombre.trim() && delGrupo && normalizar(nombre) !== normalizar(delGrupo.nombre)) {
                throw new Error(`en el grupo ${codigo}, eje_${k + 1} dice «${delGrupo.nombre}» en la fila ${filaDelExcel(delGrupo.fila)} y «${nombre.trim()}» en la fila ${filaDelExcel(f.i)}: debe ser el mismo eje en todas las filas`);
            }
            if (!delGrupo && valor.trim()) {
                throw new Error(`fila ${filaDelExcel(f.i)} (grupo ${codigo}): hay un valor en valor_${k + 1} pero falta el nombre del eje en eje_${k + 1} (por ejemplo Medida o Color)`);
            }
            if (delGrupo && !valor.trim()) {
                throw new Error(`fila ${filaDelExcel(f.i)} (grupo ${codigo}): falta el valor de «${delGrupo.nombre}» en valor_${k + 1}`);
            }
        }
    }

    const posiciones = [0, 1, 2].filter((k) => nombres[k]);
    if (!posiciones.length) throw new Error(`el grupo ${codigo} no tiene ejes: escribe en eje_1 en qué se diferencian las variantes (por ejemplo Medida) y en valor_1 el valor de cada fila`);
    const crudos = posiciones.map((k) => ({ name: nombres[k].nombre, values: filas.map((f) => f.ejes[k].valor.trim()) }));
    let ejes: EjeDeVariacion[];
    try {
        ejes = normalizarEjes(crudos);
    } catch (error: any) {
        throw new Error(`grupo ${codigo}: ${String(error?.response?.message ?? error?.message ?? error)}`);
    }

    const valores: ValoresDeVariante[] = [];
    const vistas = new Map<string, number>();
    for (const f of filas) {
        const v = valoresDeVariante(Object.fromEntries(posiciones.map((k, n) => [ejes[n].name, f.ejes[k].valor])), ejes);
        const combinacion = claveDeCombinacion(v, ejes);
        const antes = vistas.get(combinacion);
        if (antes !== undefined) {
            throw new Error(`en el grupo ${codigo}, las filas ${filaDelExcel(antes)} y ${filaDelExcel(f.i)} son la misma variante (${ejes.map((e) => `${e.name}: ${v[e.name]}`).join(', ')})`);
        }
        vistas.set(combinacion, f.i);
        valores.push(v);
    }
    return { ejes, valores };
}
