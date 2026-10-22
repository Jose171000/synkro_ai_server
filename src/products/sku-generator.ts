/**
 * Piezas puras de la generación automática de SKU: reconocer el formato que ya usa una tienda y continuarlo.
 * (La consulta a la base y la elección de la tienda viven en SkuGeneratorService.)
 */

export interface SkuAnalizado {
    /** Parte de letras y separadores antes del número final («C», «CO», «MK-TOR-»); puede ir vacía. */
    prefijo: string;
    numero: number;
    /** Cantidad de dígitos con ceros a la izquierda («0155» → 4). */
    ancho: number;
}

export interface PatronDeSku {
    prefijo: string;
    ancho: number;
}

/**
 * Parte un SKU como «prefijo + número final»: «C0155» → {C, 155, 4}, «MK-TOR-004» → {MK-TOR-, 4, 3}.
 * Si el SKU no termina en número, o su prefijo ya lleva dígitos (como «KI-0013-ROJO-M» o «KI-0013-38»), no sirve para
 * deducir la convención: devuelve null.
 */
export function analizarSku(sku: string): SkuAnalizado | null {
    const m = String(sku ?? '').trim().match(/^([^\d]*)(\d+)$/);
    if (!m) return null;
    const [, prefijo, digitos] = m;
    if (digitos.length > 12) return null;
    return { prefijo, numero: Number(digitos), ancho: digitos.length };
}

/**
 * El formato dominante de una lista de SKU (la más reciente primero): el par prefijo + ancho que más se repite, sin
 * distinguir mayúsculas. En un empate gana el que aparece antes, es decir, el más reciente. null si ninguno sirve.
 */
export function patronDominante(skusRecientesPrimero: string[]): PatronDeSku | null {
    const cuenta = new Map<string, { patron: PatronDeSku; veces: number }>();
    for (const sku of skusRecientesPrimero) {
        const a = analizarSku(sku);
        if (!a) continue;
        const clave = `${a.prefijo.toLowerCase()}|${a.ancho}`;
        const previo = cuenta.get(clave);
        if (previo) previo.veces++;
        else cuenta.set(clave, { patron: { prefijo: a.prefijo, ancho: a.ancho }, veces: 1 });
    }
    let mejor: { patron: PatronDeSku; veces: number } | null = null;
    for (const c of cuenta.values()) if (!mejor || c.veces > mejor.veces) mejor = c;
    return mejor?.patron ?? null;
}

/** Iniciales de la tienda para el prefijo por defecto: «Kassari Import» → «KI», «Maba Kids» → «MK», «Lai» → «LAI». */
export function iniciales(nombreDeLaTienda: string): string {
    const palabras = String(nombreDeLaTienda ?? '')
        .normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase()
        .split(/[^A-Z0-9]+/).filter(Boolean);
    if (!palabras.length) return 'SKU';
    if (palabras.length === 1) return palabras[0].slice(0, 3);
    return palabras.slice(0, 3).map((p) => p[0]).join('');
}

/** Arma un SKU con el relleno de ceros del formato: («C», 156, 4) → «C0156». */
export function armarSku(prefijo: string, numero: number, ancho: number): string {
    return `${prefijo}${String(numero).padStart(ancho, '0')}`;
}

/** El mayor número usado con ese prefijo entre una lista de SKU (cualquier ancho). 0 si no hay ninguno. */
export function mayorNumeroConPrefijo(skus: string[], prefijo: string): number {
    const buscado = prefijo.toLowerCase();
    let mayor = 0;
    for (const sku of skus) {
        const a = analizarSku(sku);
        if (a && a.prefijo.toLowerCase() === buscado && a.numero > mayor) mayor = a.numero;
    }
    return mayor;
}
