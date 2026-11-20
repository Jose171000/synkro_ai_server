import { leerPrecio, leerStock } from './bulk-products';
import { calcularDescuento, PedidoDeDescuento } from '../sync/descuento-general';

/**
 * Edición masiva de productos por Excel (parte pura: leer las filas y calcular qué cambia).
 * Una celda vacía significa «no tocar». Solo se editan productos que ya existen en la tienda activa, por SKU.
 */
export type CampoEditable = 'nombre' | 'precio' | 'stock' | 'descripcion' | 'descuento';

export const ALIAS_DE_COLUMNAS: Record<'sku' | CampoEditable, string[]> = {
    sku: ['sku'],
    nombre: ['nombre', 'name', 'titulo', 'título'],
    precio: ['precio', 'price'],
    stock: ['stock', 'inventario'],
    descripcion: ['descripcion', 'descripción', 'description'],
    // Cualquiera de las columnas de descuento hace que «descuento» cuente como columna reconocida.
    descuento: [
        'descuento %', 'descuento%', 'descuento (%)', 'porcentaje descuento', 'descuento porcentaje',
        'precio con descuento', 'precio descuento', 'precio oferta', 'sale price',
        'descuento desde', 'descuento hasta', 'quitar descuento',
    ],
};

/** Las columnas del descuento, una por una. */
export const ALIAS_DE_DESCUENTO = {
    porcentaje: ['descuento %', 'descuento%', 'descuento (%)', 'porcentaje descuento', 'descuento porcentaje'],
    precio: ['precio con descuento', 'precio descuento', 'precio oferta', 'sale price'],
    desde: ['descuento desde'],
    hasta: ['descuento hasta'],
    quitar: ['quitar descuento'],
};

export const MAX_NOMBRE = 250;
export const MAX_DESCRIPCION = 10_000;

export interface FilaDeEdicion {
    sku: string;
    nombre?: string;
    precio?: number;
    stock?: number;
    descripcion?: string;
    /** Descuento a poner: en soles (precio final) o en porcentaje, con fecha de fin obligatoria. */
    descuento?: PedidoDeDescuento & { hasta: string };
    quitarDescuento?: boolean;
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
    return (['nombre', 'precio', 'stock', 'descripcion', 'descuento'] as CampoEditable[]).filter((c) => ALIAS_DE_COLUMNAS[c].some((a) => presentes.has(a)));
}

function valorDe(fila: Record<string, any>, claves: string[]): string | undefined {
    const llave = Object.keys(fila).find((k) => claves.includes(norm(k)));
    if (llave === undefined) return undefined;
    const v = fila[llave];
    if (v instanceof Date) return v.toISOString().slice(0, 10); // las fechas de Excel llegan como Date
    const t = (v && typeof v === 'object' && 'text' in v ? String((v as any).text) : String(v ?? '')).trim();
    return t === '' ? undefined : t;
}

/** «2027-01-31», «31/01/2027» o «31-01-2027» (día primero, como en Perú) → «2027-01-31»; null si no es una fecha real. */
export function leerFecha(texto: string): string | null {
    const t = String(texto ?? '').trim();
    let iso: string | null = null;
    const a = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
    const b = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (a) iso = `${a[1]}-${a[2]}-${a[3]}`;
    else if (b) iso = `${b[3]}-${b[2].padStart(2, '0')}-${b[1].padStart(2, '0')}`;
    if (!iso) return null;
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** «15», «15%», «15,5» o 0.15 (una celda con formato de porcentaje) → 15; null si no es un número mayor que 0. */
export function leerPorcentaje(texto: string): number | null {
    const n = leerPrecio(String(texto).replace('%', ''));
    if (n === null) return null;
    // Excel guarda «15%» como 0.15: un valor menor que 1 se entiende como fracción (Mercado Libre no admite menos de 5% de todos modos).
    return n < 1 ? Math.round(n * 10000) / 100 : n;
}

const ES_SI = /^(si|sí|x|1|true|yes|verdadero)$/i;

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

        // ── Descuento general: en porcentaje o en soles, con fecha de fin obligatoria ──
        const pct = valorDe(cruda, ALIAS_DE_DESCUENTO.porcentaje);
        const soles = valorDe(cruda, ALIAS_DE_DESCUENTO.precio);
        const desdeTxt = valorDe(cruda, ALIAS_DE_DESCUENTO.desde);
        const hastaTxt = valorDe(cruda, ALIAS_DE_DESCUENTO.hasta);
        const quitar = valorDe(cruda, ALIAS_DE_DESCUENTO.quitar);
        if (quitar !== undefined && ES_SI.test(quitar)) {
            if (pct !== undefined || soles !== undefined) errores.push('No puedes quitar y poner un descuento en la misma fila.');
            else fila.quitarDescuento = true;
        } else if (pct !== undefined || soles !== undefined) {
            if (pct !== undefined && soles !== undefined) {
                errores.push('Pon el descuento en porcentaje o en soles, no los dos.');
            } else {
                const modo = pct !== undefined ? 'porcentaje' : 'precio';
                const valor = modo === 'porcentaje' ? leerPorcentaje(pct!) : leerPrecio(soles!);
                if (valor === null) errores.push(`Descuento no válido: «${pct ?? soles}» (debe ser un número mayor que 0).`);
                const hasta = hastaTxt === undefined ? null : leerFecha(hastaTxt);
                const desde = desdeTxt === undefined ? undefined : leerFecha(desdeTxt);
                if (hastaTxt === undefined) errores.push('El descuento necesita «Descuento hasta» (fecha de fin).');
                else if (hasta === null) errores.push(`«Descuento hasta» no es una fecha válida: «${hastaTxt}» (usa AAAA-MM-DD o DD/MM/AAAA).`);
                if (desde === null) errores.push(`«Descuento desde» no es una fecha válida: «${desdeTxt}» (usa AAAA-MM-DD o DD/MM/AAAA).`);
                if (valor !== null && hasta) fila.descuento = { modo, valor, hasta, ...(desde ? { desde } : {}) };
            }
        } else if (desdeTxt !== undefined || hastaTxt !== undefined) {
            errores.push('Hay fechas de descuento pero falta el porcentaje o el precio con descuento.');
        }
        return fila;
    });
}

export interface ProductoActual {
    name: string;
    price: number | string | null;
    stock: number | null;
    description: string | null;
    salePrice?: number | string | null;
    saleEndDate?: string | null;
}

/**
 * Lo que cambiaría en un producto: solo los campos que el Excel trae y que de verdad son distintos.
 * Lanza un Error (con mensaje para la persona) si el descuento no se puede aplicar a este producto.
 */
export function calcularCambios(fila: FilaDeEdicion, p: ProductoActual): Cambio[] {
    const cambios: Cambio[] = [];
    const precioActual = p.price == null ? null : Number(p.price);
    if (fila.nombre !== undefined && fila.nombre !== (p.name ?? '')) cambios.push({ campo: 'nombre', antes: p.name ?? null, despues: fila.nombre });
    if (fila.precio !== undefined && fila.precio !== precioActual) cambios.push({ campo: 'precio', antes: precioActual, despues: fila.precio });
    if (fila.stock !== undefined && fila.stock !== (p.stock ?? null)) cambios.push({ campo: 'stock', antes: p.stock ?? null, despues: fila.stock });
    if (fila.descripcion !== undefined && fila.descripcion !== (p.description ?? '').trim()) {
        cambios.push({ campo: 'descripcion', antes: p.description ? p.description.slice(0, 120) : null, despues: fila.descripcion.slice(0, 120) });
    }

    const salePrice = p.salePrice == null ? null : Number(p.salePrice);
    if (fila.quitarDescuento) {
        if (salePrice !== null) cambios.push({ campo: 'descuento', antes: salePrice, despues: 'quitar' });
    } else if (fila.descuento) {
        // El descuento se calcula sobre el precio nuevo si la misma fila también lo cambia.
        const base = fila.precio ?? precioActual;
        const c = calcularDescuento(Number(base), fila.descuento);
        const igual = salePrice === c.salePrice && String(p.saleEndDate ?? '').slice(0, 10) === c.hasta;
        if (!igual) cambios.push({ campo: 'descuento', antes: salePrice, despues: `${c.salePrice.toFixed(2)} (${c.porcentaje}% menos) del ${c.desde} al ${c.hasta}` });
    }
    return cambios;
}

export const cambiaInventario = (cambios: Cambio[]) => cambios.some((c) => c.campo === 'precio' || c.campo === 'stock');
export const cambiaDescuento = (cambios: Cambio[]) => cambios.some((c) => c.campo === 'descuento');
