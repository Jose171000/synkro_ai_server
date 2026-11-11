/**
 * Publicar productos nuevos en Ripley (Mirakl): validar lo que Ripley exige y armar el CSV de «Productos y ofertas» con las
 * columnas OFICIALES de la plantilla del portal (verificadas el 2026-11-10 con la plantilla de la categoría Loncheras).
 * Funciones puras, sin red ni base de datos: lo que se envía se puede revisar ANTES de mandar nada.
 */

/** Columnas fijas que van antes de los atributos propios de la categoría (así las trae la plantilla del portal). */
export const COLUMNAS_ANTES = [
    'categoria', 'sku_seller', 'nombre', 'ShortDescription', 'descripcion', 'marca', 'imagen', 'thumbnail',
    'imagen2', 'imagen3', 'imagen4', 'imagen5', 'imagen6', 'imagen7', 'imagen8', 'imagen9', 'imagen10',
    'variant_id', 'ean', 'largo_empaque', 'ancho_empaque', 'alto_empaque', 'peso_empaque',
    'uso_interno_r', 'is_displayable', 'uso_interno_op', 'keywords', 'info_ff',
];

/** Columnas de la oferta (precio y stock), después de los atributos. */
export const COLUMNAS_DESPUES = [
    'sku', 'product-id', 'product-id-type', 'description', 'internal-description', 'price', 'price-additional-info', 'quantity',
    'min-quantity-alert', 'state', 'available-start-date', 'available-end-date', 'logistic-class', 'discount-price',
    'discount-start-date', 'discount-end-date', 'leadtime-to-ship', 'update-delete',
];

export const MAX_NOMBRE = 125;
export const MAX_IMAGENES = 10;
export const MAX_SKU = 40;

/** Un campo de la categoría de Ripley que se valida y se escribe como columna. */
export interface CampoDeCategoria {
    name: string;
    label: string;
    required: boolean;
    /** Define la variante (color, talla…). */
    isVariant?: boolean;
}

export interface ProductoParaRipley {
    sku: string;
    categoria: { id: string; ruta: string } | null;
    nombre: string;
    descripcionCorta: string;
    /** La descripción completa: la ficha HTML general del producto (Ripley la acepta). */
    descripcion: string;
    marca: string;
    /** ¿La marca está en el catálogo aprobado de Ripley? (la comprueba quien arma el producto con la lista de 27.116) */
    marcaValida: boolean;
    imagenes: string[];
    precio: number | null;
    stock: number | null;
    /** Medidas y peso del paquete ya embalado (cm y kg): recomendadas por Ripley. */
    paquete?: { largo?: number | null; ancho?: number | null; alto?: number | null; peso?: number | null } | null;
    /** Valores de los atributos de la categoría por código (color_80, tipo_product…), ya llevados a las listas de Ripley. */
    atributos: Record<string, string>;
    /** Código común de las variantes que se publican juntas en UNA publicación; vacío si el producto va solo o separado. */
    varianteDe?: string | null;
    ean?: string | null;
    keywords?: string[];
}

export interface ProblemasDePublicacion {
    /** Impiden enviar: Ripley lo rechazaría. */
    errores: string[];
    /** No impiden enviar, pero conviene saberlo. */
    avisos: string[];
}

const esUrlHttp = (u: string) => /^https?:\/\/\S+$/i.test(u);
const conExtensionDeImagen = (u: string) => /\.(jpe?g|png)(\?.*)?$/i.test(u);
const vacio = (v: unknown) => v === null || v === undefined || String(v).trim() === '';

/** La categoría tal como la pide la plantilla: «MALETERÍA, BOLSOS Y CARTERAS/LONCHERAS» (nuestra ruta usa «›»). */
export function rutaParaCsv(ruta: string): string {
    return String(ruta ?? '').split('›').map((t) => t.trim()).filter(Boolean).join('/');
}

/** Lo que Ripley rechazaría, y lo que conviene revisar, de un producto antes de enviarlo. */
export function validarProductoParaRipley(p: ProductoParaRipley, campos: CampoDeCategoria[]): ProblemasDePublicacion {
    const errores: string[] = [];
    const avisos: string[] = [];
    const sku = String(p.sku ?? '').trim();

    if (!sku) errores.push('Falta el SKU.');
    else if (sku.length > MAX_SKU) errores.push(`El SKU «${sku}» tiene más de ${MAX_SKU} caracteres.`);
    else if (sku.includes('/')) errores.push(`El SKU «${sku}» tiene el carácter «/», que Ripley no admite.`);

    if (!p.categoria?.id) errores.push('Falta la categoría de Ripley.');
    if (vacio(p.nombre)) errores.push('Falta el nombre para Ripley.');
    else if (String(p.nombre).length > MAX_NOMBRE) errores.push(`El nombre tiene ${String(p.nombre).length} caracteres: Ripley admite hasta ${MAX_NOMBRE}.`);
    if (vacio(p.descripcionCorta)) errores.push('Falta la descripción corta.');
    if (vacio(p.descripcion)) errores.push('Falta la descripción completa.');

    if (vacio(p.marca)) errores.push('Falta la marca.');
    else if (!p.marcaValida) errores.push(`La marca «${p.marca}» no está en el catálogo aprobado de Ripley: elige otra o usa GENÉRICO.`);

    const imagenes = (p.imagenes ?? []).filter((u) => !vacio(u));
    if (!imagenes.length) errores.push('Falta al menos una foto (la imagen principal y la miniatura son obligatorias).');
    for (const u of imagenes.slice(0, MAX_IMAGENES)) {
        if (!esUrlHttp(u)) errores.push(`La foto «${u.slice(0, 60)}» no es un enlace público (http/https).`);
    }
    if (imagenes.some((u) => esUrlHttp(u) && !conExtensionDeImagen(u))) {
        avisos.push('Algunos enlaces de fotos no terminan en .jpg o .png: Ripley podría rechazarlos. Si falla, las fotos se sirven desde Synkro.');
    }
    if (imagenes.length > MAX_IMAGENES) avisos.push(`Ripley admite ${MAX_IMAGENES} fotos: se enviarán las primeras ${MAX_IMAGENES}.`);

    if (p.precio === null || p.precio === undefined || !Number.isFinite(Number(p.precio)) || Number(p.precio) <= 0) errores.push('Falta un precio mayor que cero.');
    if (p.stock === null || p.stock === undefined || !Number.isInteger(Number(p.stock)) || Number(p.stock) < 0) errores.push('El stock debe ser un número entero, cero o mayor.');

    for (const c of campos.filter((x) => x.required)) {
        if (vacio(p.atributos?.[c.name])) errores.push(`Falta el dato obligatorio «${c.label}».`);
    }

    const paquete = p.paquete ?? {};
    const sinMedidas = (['largo', 'ancho', 'alto', 'peso'] as const).filter((k) => vacio(paquete[k]) || Number(paquete[k]) <= 0);
    if (sinMedidas.length) avisos.push('Faltan las medidas o el peso del paquete: Ripley los recomienda para calcular el envío.');
    return { errores, avisos };
}

/** Un valor listo para el CSV: texto sin saltos de línea sueltos que rompan columnas (se entrecomilla en `armarCsv`). */
const texto = (v: unknown) => (vacio(v) ? '' : String(v).trim());
const numero = (v: unknown) => (vacio(v) || !Number.isFinite(Number(v)) ? '' : String(Number(v)));

/** La fila del CSV de un producto: columnas fijas, atributos de la categoría y oferta. */
export function filaDeRipley(p: ProductoParaRipley, columnasDeAtributos: string[]): Record<string, string> {
    const imagenes = (p.imagenes ?? []).filter((u) => !vacio(u)).slice(0, MAX_IMAGENES);
    const fila: Record<string, string> = {
        categoria: rutaParaCsv(p.categoria?.ruta ?? ''),
        sku_seller: texto(p.sku),
        nombre: texto(p.nombre).toLocaleUpperCase('es'),
        ShortDescription: texto(p.descripcionCorta),
        descripcion: texto(p.descripcion),
        marca: texto(p.marca),
        imagen: imagenes[0] ?? '',
        thumbnail: imagenes[0] ?? '',
        variant_id: texto(p.varianteDe),
        ean: texto(p.ean),
        largo_empaque: numero(p.paquete?.largo),
        ancho_empaque: numero(p.paquete?.ancho),
        alto_empaque: numero(p.paquete?.alto),
        peso_empaque: numero(p.paquete?.peso),
        is_displayable: 'true',
        keywords: (p.keywords ?? []).map((k) => k.trim()).filter(Boolean).join(','),
        sku: texto(p.sku),
        'product-id': texto(p.sku),
        'product-id-type': 'SHOP_SKU',
        price: numero(p.precio),
        quantity: numero(p.stock),
        state: 'Nuevo',
        'update-delete': 'UPDATE',
    };
    imagenes.slice(1).forEach((u, i) => { fila[`imagen${i + 2}`] = u; });
    for (const codigo of columnasDeAtributos) fila[codigo] = texto(p.atributos?.[codigo]);
    return fila;
}

/** Los códigos de atributo de la categoría que van como columna (sin repetir las fijas). */
export function columnasDeAtributos(campos: { name: string }[]): string[] {
    const fijas = new Set([...COLUMNAS_ANTES, ...COLUMNAS_DESPUES]);
    return [...new Set(campos.map((c) => c.name))].filter((n) => !fijas.has(n));
}

const CELDA_RIESGOSA = /[;"\r\n]/;
const celda = (v: string) => (CELDA_RIESGOSA.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** El CSV completo: encabezado con los códigos de la plantilla, separador «;», UTF-8. Cada fila usa las mismas columnas. */
export function armarCsv(filas: Record<string, string>[], atributos: string[]): { csv: string; columnas: string[] } {
    const columnas = [...COLUMNAS_ANTES.slice(0, COLUMNAS_ANTES.length), ...atributos, ...COLUMNAS_DESPUES];
    const lineas = [columnas.join(';'), ...filas.map((f) => columnas.map((c) => celda(f[c] ?? '')).join(';'))];
    return { csv: `${lineas.join('\r\n')}\r\n`, columnas };
}
