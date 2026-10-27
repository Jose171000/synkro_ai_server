/**
 * Campos que Falabella lista entre los atributos de una categoría pero que NO son datos del producto que
 * se completen a mano o con IA: los pone la plataforma por su cuenta, o son del sistema (identificadores,
 * impuestos, tipo de envío, variantes). Enviarlos puede hacer que Falabella rechace la ficha con
 * «… is/are not applicable to <categoría>».
 */
const LISTA_DE_SISTEMA = [
    // Los cubre la plataforma al publicar
    'name', 'brand', 'description', 'primary_category', 'seller_sku',
    'condition_type', 'package_width', 'package_length', 'package_height',
    'package_weight', 'variation', 'price', 'stock', 'status',
    // De sistema: no aplican a todas las categorías y no son datos del producto
    'parent_sku', 'tax_class', 'shipment_type', 'product_id', 'shop_sku',
    'sale_price', 'sale_start_date', 'sale_end_date', 'quantity', 'product_group', 'operator_code',
];

/** Nombre normalizado de un atributo, para compararlo sin importar mayúsculas, guiones o guiones bajos. */
export const claveDeAtributo = (nombre: string) => String(nombre ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const CLAVES_DE_SISTEMA = new Set(LISTA_DE_SISTEMA.map(claveDeAtributo));

/**
 * Los datos comerciales (precio, precio de oferta, stock y las fechas de la oferta) los fija Synkro desde lo que digitó el
 * cliente: ni la IA ni la ficha del canal deben generarlos. Falabella los lista entre los atributos de algunas categorías
 * («Precio (Falabella)», «Stock (Falabella)»…) con nombres distintos según la categoría, así que se reconocen por nombre y por etiqueta.
 */
const COMERCIAL_POR_NOMBRE = /price|stock|specialfrom|specialto|salestart|saleend|saledate/;
const COMERCIAL_POR_ETIQUETA = [/\(falabella\).*(precio|stock|oferta|descuento|cantidad)|(precio|stock|oferta|descuento|cantidad).*\(falabella\)/, /fecha .*(oferta|precio)/];

const sinTildes = (t: string) => String(t ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/**
 * Los nombres de los atributos llegan escritos de varias formas según la categoría («tax_class», «TaxClass»,
 * «taxclass»…): la comparación ignora mayúsculas, guiones y guiones bajos.
 */
class ConjuntoDeSistema extends Set<string> {
    has(nombre: string): boolean {
        const clave = claveDeAtributo(nombre);
        return CLAVES_DE_SISTEMA.has(clave) || COMERCIAL_POR_NOMBRE.test(clave);
    }
}

export const ATRIBUTOS_DE_SISTEMA: Set<string> = new ConjuntoDeSistema(LISTA_DE_SISTEMA);

/** Un atributo de categoría que NO se completa con IA ni se manda como dato del producto: de sistema, o precio, oferta o stock. */
export function esAtributoDeSistema(a: { name?: string; feedName?: string; label?: string }): boolean {
    if (ATRIBUTOS_DE_SISTEMA.has(String(a?.name ?? '')) || ATRIBUTOS_DE_SISTEMA.has(String(a?.feedName ?? ''))) return true;
    const etiqueta = sinTildes(a?.label ?? '');
    return !!etiqueta && COMERCIAL_POR_ETIQUETA.some((r) => r.test(etiqueta));
}

/**
 * Atributos que Falabella respondió que «no aplican» a la categoría de este producto. Se guardan en el
 * propio producto para no volver a enviarlos en el siguiente intento.
 */
export function atributosQueNoAplican(aiAttributes: Record<string, any> | null | undefined): Set<string> {
    const lista = (aiAttributes as any)?._noAplica;
    return new Set(Array.isArray(lista) ? lista.map(claveDeAtributo) : []);
}

/** De «0: ParentSku, TaxClass, ShipmentType is/are not applicable to Bebés» → ['ParentSku','TaxClass','ShipmentType']. */
export function leerAtributosNoAplicables(mensaje: string | null | undefined): string[] {
    const m = String(mensaje ?? '').match(/(?:\d+:\s*)?(.+?)\s+is\/are not applicable/i);
    if (!m) return [];
    return m[1].split(',').map((t) => t.trim()).filter(Boolean);
}

/** ¿Falabella pide un número en este campo? (su tipo de entrada es «numberfield», «numeric»…) */
export function esCampoNumerico(inputType: string | null | undefined): boolean {
    return /number|numeric|integer|decimal/i.test(String(inputType ?? ''));
}

/**
 * El primer número de un texto, sin unidades ni palabras: «3000 hilos» → «3000», «1,5 kg» → «1.5».
 * Un entero se devuelve sin decimales. Sin ningún número devuelve undefined.
 */
export function soloElNumero(texto: string | null | undefined): string | undefined {
    const m = String(texto ?? '').match(/-?\d+(?:[.,]\d+)?/);
    if (!m) return undefined;
    const n = Number(m[0].replace(',', '.'));
    return Number.isFinite(n) ? String(n) : undefined;
}

/** Falabella devuelve sus mensajes con entidades HTML («&#039;»): se pasan a texto normal para mostrarlos y analizarlos. */
export function decodificarEntidades(texto: string | null | undefined): string {
    return String(texto ?? '')
        .replace(/&#0*39;|&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

/** De «3: Field 'TamanoCamaVariant' cannot be empty» → ['TamanoCamaVariant']: datos que Falabella exige aunque su ficha de la categoría no los marque obligatorios. */
export function leerAtributosVacios(mensaje: string | null | undefined): string[] {
    const salida: string[] = [];
    const re = /Field\s+'([^']+)'\s+cannot be empty/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(decodificarEntidades(mensaje))) !== null) salida.push(m[1]);
    return salida;
}

/** Atributos que Falabella ya rechazó por vacíos en este producto: desde entonces se tratan como obligatorios. */
export function atributosObligatoriosAprendidos(aiAttributes: Record<string, any> | null | undefined): Set<string> {
    const lista = (aiAttributes as any)?._obligatorios;
    return new Set(Array.isArray(lista) ? lista.map(claveDeAtributo) : []);
}

/**
 * Límites de longitud de atributos de texto que Falabella rechaza al pasarse («'…' is more than 172 characters long»).
 * Se conocen algunos de antemano y el resto se aprende del mensaje de error (ver leerLimitesDeLongitud).
 */
const LIMITES_CONOCIDOS: { patron: RegExp; max: number }[] = [
    { patron: /contenidodelpaquete|packagecontent|contentofpackage|contenidopaquete/, max: 172 },
];

/** Máximo de caracteres de un atributo: el aprendido de un rechazo anterior o el conocido; undefined si no hay límite. */
export function limiteDeLongitud(
    atributo: { name?: string; feedName?: string; label?: string },
    aiAttributes: Record<string, any> | null | undefined,
): number | undefined {
    const claves = [atributo.name, atributo.feedName, atributo.label].map(x => claveDeAtributo(x ?? '')).filter(Boolean);
    const aprendidos = (aiAttributes as any)?._maxLen as Record<string, number> | undefined;
    for (const c of claves) if (aprendidos && Number(aprendidos[c]) > 0) return Number(aprendidos[c]);
    return LIMITES_CONOCIDOS.find(l => claves.some(c => l.patron.test(c)))?.max;
}

/** De «0: 'Set de…' is more than 172 characters long» → [{ valor: 'Set de…', max: 172 }]. */
export function leerLimitesDeLongitud(mensaje: string | null | undefined): { valor: string; max: number }[] {
    const salida: { valor: string; max: number }[] = [];
    const re = /'([\s\S]+?)'\s+is more than\s+(\d+)\s+characters long/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(String(mensaje ?? ''))) !== null) salida.push({ valor: m[1], max: Number(m[2]) });
    return salida;
}

/**
 * Acorta un texto al máximo sin partir una palabra ni dejar un paréntesis abierto: corta en la última coma o espacio,
 * quita conectores sueltos al final y cierra el paréntesis si hace falta.
 */
export function recortarTexto(texto: string, max: number): string {
    let t = String(texto ?? '').trim();
    if (t.length <= max) return t;
    for (let tope = max; tope > 0; tope--) {
        let c = t.slice(0, tope);
        // Si no cortamos justo en un límite de palabra, se vuelve a la última coma o espacio.
        if (/\S/.test(t[tope] ?? '') && /\S/.test(c[c.length - 1])) {
            const corte = Math.max(c.lastIndexOf(','), c.lastIndexOf(' '));
            if (corte > max * 0.4) c = c.slice(0, corte);
        }
        c = c.replace(/[\s,;:\-–(]+$/, '').replace(/\s+(y|e|o|u|de|del|con|para|la|el|los|las|un|una)$/i, '').replace(/[\s,;:\-–(]+$/, '');
        const abiertos = (c.match(/\(/g) ?? []).length - (c.match(/\)/g) ?? []).length;
        if (abiertos > 0) c += ')'.repeat(abiertos);
        if (c.length <= max) return c;
    }
    return t.slice(0, max);
}

/**
 * ¿El rechazo de Falabella significa que la categoría no corresponde al producto? Lo delatan las reglas propias de una
 * categoría que el producto incumple por mucho («el peso debe estar entre 9 kg y 27 kg para esta categoría»).
 */
export function esCategoriaEquivocada(mensaje: string | null | undefined): boolean {
    const m = String(mensaje ?? '');
    if (!/categor/i.test(m)) return false;
    return /(entre|between)\s+[\d.,]+\s*(kg|g|cm|mm|m|l)\b/i.test(m)
        || /(no (corresponde|pertenece|es v[aá]lid[oa])|does not belong|not allowed|no permitid)/i.test(m);
}
