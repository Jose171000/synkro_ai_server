import { leerPrecio, leerStock } from './bulk-products';

/**
 * Edición masiva de productos por Excel (parte pura: leer las filas y calcular qué cambia).
 * Una celda vacía significa «no tocar». Solo se editan productos que ya existen en la tienda activa, por SKU.
 */
export type CampoEditable = 'nombre' | 'precio' | 'stock' | 'descripcion';

export const ALIAS_DE_COLUMNAS: Record<'sku' | CampoEditable, string[]> = {
    sku: ['sku'],
    nombre: ['nombre', 'name', 'titulo', 'título'],
    precio: ['precio', 'price'],
    stock: ['stock', 'inventario'],
    descripcion: ['descripcion', 'descripción', 'description'],
};

export const MAX_NOMBRE = 250;
export const MAX_DESCRIPCION = 10_000;

export interface FilaDeEdicion {
    sku: string;
    nombre?: string;
    precio?: number;
    stock?: number;
    descripcion?: string;
    errores: string[];
}

export interface Cambio {
    campo: CampoEditable;
    antes: string | number | null;
    despues: string | number;
}

const norm = (t: string) => t.trim().toLowerCase();

/** Las columnas del Excel que la edición reconoce (en español o en inglés, sin importar mayúsculas). */
export function columnasReconocidas(filas: Record<string, any>[]): CampoEditable[] {
    const presentes = new Set(filas.flatMap((f) => Object.keys(f).map(norm)));
    return (['nombre', 'precio', 'stock', 'descripcion'] as CampoEditable[]).filter((c) => ALIAS_DE_COLUMNAS[c].some((a) => presentes.has(a)));
}

function valorDe(fila: Record<string, any>, claves: string[]): string | undefined {
    const llave = Object.keys(fila).find((k) => claves.includes(norm(k)));
    if (llave === undefined) return undefined;
    const v = fila[llave];
    const t = (v && typeof v === 'object' && 'text' in v ? String((v as any).text) : String(v ?? '')).trim();
    return t === '' ? undefined : t;
}

export function leerFilasDeEdicion(crudas: Record<string, any>[]): FilaDeEdicion[] {
    const vistos = new Set<string>();
    return crudas.map((cruda) => {
        const errores: string[] = [];
        const sku = valorDe(cruda, ALIAS_DE_COLUMNAS.sku) ?? '';
        if (!sku) errores.push('Falta el SKU.');
        else if (vistos.has(norm(sku))) errores.push('El SKU está repetido en el archivo.');
        if (sku) vistos.add(norm(sku));

        const fila: FilaDeEdicion = { sku, errores };
        const nombre = valorDe(cruda, ALIAS_DE_COLUMNAS.nombre);
        if (nombre !== undefined) {
            if (nombre.length > MAX_NOMBRE) errores.push(`El nombre pasa de ${MAX_NOMBRE} caracteres.`);
            else fila.nombre = nombre;
        }
        const precio = valorDe(cruda, ALIAS_DE_COLUMNAS.precio);
        if (precio !== undefined) {
            const n = leerPrecio(precio);
            if (n === null) errores.push(`Precio no válido: «${precio}» (debe ser un número mayor que 0).`);
            else fila.precio = n;
        }
        const stock = valorDe(cruda, ALIAS_DE_COLUMNAS.stock);
        if (stock !== undefined) {
            const n = leerStock(stock);
            if (n === null) errores.push(`Stock no válido: «${stock}» (debe ser un entero de 0 en adelante).`);
            else fila.stock = n;
        }
        const descripcion = valorDe(cruda, ALIAS_DE_COLUMNAS.descripcion);
        if (descripcion !== undefined) {
            if (descripcion.length > MAX_DESCRIPCION) errores.push(`La descripción pasa de ${MAX_DESCRIPCION} caracteres.`);
            else fila.descripcion = descripcion;
        }
        return fila;
    });
}

export interface ProductoActual {
    name: string;
    price: number | string | null;
    stock: number | null;
    description: string | null;
}

/** Lo que cambiaría en un producto: solo los campos que el Excel trae y que de verdad son distintos. */
export function calcularCambios(fila: FilaDeEdicion, p: ProductoActual): Cambio[] {
    const cambios: Cambio[] = [];
    const precioActual = p.price == null ? null : Number(p.price);
    if (fila.nombre !== undefined && fila.nombre !== (p.name ?? '')) cambios.push({ campo: 'nombre', antes: p.name ?? null, despues: fila.nombre });
    if (fila.precio !== undefined && fila.precio !== precioActual) cambios.push({ campo: 'precio', antes: precioActual, despues: fila.precio });
    if (fila.stock !== undefined && fila.stock !== (p.stock ?? null)) cambios.push({ campo: 'stock', antes: p.stock ?? null, despues: fila.stock });
    if (fila.descripcion !== undefined && fila.descripcion !== (p.description ?? '')) {
        cambios.push({ campo: 'descripcion', antes: p.description ? p.description.slice(0, 120) : null, despues: fila.descripcion.slice(0, 120) });
    }
    return cambios;
}

export const cambiaInventario = (cambios: Cambio[]) => cambios.some((c) => c.campo === 'precio' || c.campo === 'stock');
