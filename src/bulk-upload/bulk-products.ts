/**
 * Lectura de la plantilla de carga masiva de productos: columnas, precio, stock y fotos.
 * Solo funciones puras: la subida de las fotos y la cola viven en el controlador.
 */

/** Cuántas fotos se toman por producto (Falabella admite hasta 8). */
export const MAX_FOTOS = 8;

export const COLUMNAS = {
    sku: ['sku'],
    precio: ['precio', 'price'],
    stock: ['stock', 'cantidad'],
    fotos: ['fotos', 'foto', 'imagenes', 'imágenes', 'image', 'imagen', 'img', 'photo'],
    nombre: ['nombre', 'productname', 'name', 'producto'],
    descripcion: ['descripcion', 'descripción', 'description', 'detalle'],
    canales: ['canales', 'targetmarketplaces', 'marketplaces'],
    precioDescuento: ['precio_descuento', 'precio descuento', 'descuento', 'preciodescuento', 'saleprice'],
    descuentoDesde: ['descuento_desde', 'descuento desde', 'desde'],
    descuentoHasta: ['descuento_hasta', 'descuento hasta', 'hasta'],
};

/** Lista separada por comas, punto y coma, barras o saltos de línea. */
export function partirLista(valor: string | undefined | null): string[] {
    return String(valor ?? '').split(/[,;|\n]+/).map(t => t.trim()).filter(Boolean);
}

/** Solo JPG/JPEG, que es lo que aceptan todos los canales. Una URL puede traer parámetros detrás. */
export function esJpg(ruta: string): boolean {
    return /\.jpe?g$/i.test(String(ruta).split(/[?#]/)[0].trim());
}

export function esUrl(ruta: string): boolean {
    return /^https?:\/\//i.test(ruta.trim());
}

/** Ruta normalizada para buscar dentro del ZIP: sin «./», con «/» y en minúsculas. */
export function claveDeRuta(ruta: string): string {
    return String(ruta).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim().toLowerCase();
}

/** Precio en soles escrito de cualquier forma («S/ 1,250.50», «250,5», «250»). Devuelve null si no es válido. */
export function leerPrecio(valor: string | undefined | null): number | null {
    let t = String(valor ?? '').replace(/[^\d.,]/g, '');
    if (!t) return null;
    if (t.includes(',') && t.includes('.')) t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    else if (t.includes(',')) t = /,\d{1,2}$/.test(t) ? t.replace(',', '.') : t.replace(/,/g, '');
    const n = Number(t);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** Stock entero. Vacío = 0; negativo o con letras = null (inválido). */
export function leerStock(valor: string | undefined | null): number | null {
    const t = String(valor ?? '').trim();
    if (!t) return 0;
    if (!/^\d+([.,]0+)?$/.test(t)) return null;
    return Math.trunc(Number(t.replace(',', '.')));
}

/**
 * Las fotos de un SKU dentro del ZIP cuando el Excel no las lista: una carpeta con su nombre
 * (`MK-001/1.jpg`) o archivos que empiezan por el SKU (`MK-001.jpg`, `MK-001-2.jpg`, `MK-001_3.jpg`).
 * `otrosSkus` evita que «MK-001-2» (otro producto) se tome como segunda foto de «MK-001».
 */
export function fotosDeCarpeta(sku: string, rutas: string[], otrosSkus: Set<string> = new Set()): string[] {
    const s = claveDeRuta(sku);
    if (!s) return [];
    const porNombre = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
    const coinciden = rutas.filter(r => {
        const clave = claveDeRuta(r);
        if (!esJpg(clave)) return false;
        const partes = clave.split('/');
        const archivo = partes[partes.length - 1].replace(/\.jpe?g$/, '');
        if (partes.slice(0, -1).includes(s)) return true;
        if (otrosSkus.has(archivo) && archivo !== s) return false;
        return archivo === s || new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s_-]*\\d+$`).test(archivo);
    });
    return coinciden.sort(porNombre).slice(0, MAX_FOTOS);
}

/**
 * Fecha escrita en el Excel: «2026-11-30», «30/11/2026» o la fecha que Excel entrega al leer una celda de fecha.
 * Devuelve «AAAA-MM-DD», null si está vacía y undefined si no se entiende.
 */
export function leerFecha(valor: string | undefined | null): string | null | undefined {
    const t = String(valor ?? '').trim();
    if (!t) return null;
    let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const d = new Date(t);
    if (!Number.isNaN(d.getTime()) && /\d{4}/.test(t)) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return undefined;
}
