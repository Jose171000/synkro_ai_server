import { normalizar } from './variantes';

/** Colores que suelen colarse en el nombre de un producto con variantes («Perchero Metal Negro Azul»). */
const COLORES = new Set([
    'negro', 'blanco', 'azul', 'celeste', 'rojo', 'verde', 'amarillo', 'rosa', 'rosado', 'morado', 'gris', 'naranja', 'marron', 'cafe',
    'beige', 'dorado', 'plateado', 'plata', 'turquesa', 'violeta', 'lila', 'crema', 'fucsia', 'vino', 'multicolor', 'transparente',
]);
const UNIONES = new Set(['y', 'e', 'con', '-', '/', '|', '·']);

/** Corta en una palabra entera: «Perchero Metal Ne» nunca queda a medias. Si no cabe ni una palabra, corta seco. */
export function recortarEnPalabra(texto: string, max: number): string {
    const limpio = String(texto ?? '').replace(/\s+/g, ' ').trim();
    if (limpio.length <= max) return limpio;
    const corte = limpio.slice(0, max + 1);
    const ultimoEspacio = corte.lastIndexOf(' ');
    return (ultimoEspacio >= Math.floor(max / 2) ? corte.slice(0, ultimoEspacio) : limpio.slice(0, max)).trim();
}

/** Quita del final las palabras que son colores o valores de los ejes: lo que distingue a una variante no va en el nombre común. */
export function sinValoresAlFinal(texto: string, valoresDelGrupo: string[] = []): string {
    const propios = new Set(valoresDelGrupo.map((v) => normalizar(v)).filter(Boolean));
    const palabras = String(texto ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    while (palabras.length > 1) {
        const ultima = normalizar(palabras[palabras.length - 1]);
        if (COLORES.has(ultima) || propios.has(ultima) || UNIONES.has(ultima)) palabras.pop();
        else break;
    }
    return palabras.join(' ');
}

/**
 * Título de una variante cuando el canal no la agrupa: el del producto más su combinación («… Metal - Celeste»), sin pasar
 * de `max` y sin partir palabras. Los colores del final del título común se quitan para no escribir «Negro - Negro».
 */
export function tituloDeVariante(base: string | undefined, etiqueta: string, valoresDelGrupo: string[] = [], max = 60): string | undefined {
    if (!base) return undefined;
    const sufijo = ` - ${etiqueta}`;
    const espacio = Math.max(10, max - sufijo.length);
    const comun = sinValoresAlFinal(recortarEnPalabra(base, espacio), valoresDelGrupo);
    return `${comun}${sufijo}`.slice(0, max);
}

/**
 * Nombre común de la familia en Mercado Libre. Mercado Libre agrega solo el color al título de cada publicación, así que
 * el nombre de la familia no lleva colores ni los valores de los ejes, y es idéntico en todas las variantes.
 */
export function nombreDeFamilia(nombre: string, valoresDelGrupo: string[] = [], max = 60): string {
    return recortarEnPalabra(sinValoresAlFinal(recortarEnPalabra(nombre, 150), valoresDelGrupo), max);
}

/** Texto sin tildes ni símbolos: «Tamaño cama» → «tamanocama», «COMFORTER_MATTRESS_SIZE» → «comfortermattresssize». */
const laxo = (t: string) => normalizar(String(t ?? '')).replace(/[^a-z0-9]/g, '');
/** ¿El eje o dato habla de la medida del producto (talla, tamaño, tamaño de cama, plazas)? */
const esDeMedida = (t: string) => /talla|size|tamano|tamanio|plaza|medida/.test(laxo(t));

const claveLaxa = (t: string) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Los atributos del producto con los valores de ESTA variante por encima de los del molde: el color del producto base
 * («Azul») no debe ganarle al de la variante («Negro»). Solo se reemplaza lo que ya existe; en el color también el color básico.
 */
export function atributosConVariante(atributos: Record<string, any>, valores?: Record<string, string> | null): Record<string, any> {
    const salida: Record<string, any> = { ...(atributos ?? {}) };
    for (const [eje, valor] of Object.entries(valores ?? {})) {
        const ejeLaxo = laxo(eje);
        const medida = esDeMedida(eje);
        const colores = ejeLaxo === 'color' ? [ejeLaxo, 'colorbasico', 'maincolor', 'colorprincipal', 'colorfiltrable', 'filtrablecolor'] : [];
        for (const clave of Object.keys(salida)) {
            const k = laxo(clave);
            // El mismo dato con el sufijo «variant» que usan los canales («Color variant», «Tamaño cama variant»).
            const igual = k === ejeLaxo || k === ejeLaxo + 'variant' || colores.includes(k) || colores.some((c) => k === c + 'variant');
            // Medida (talla, tamaño de cama, plazas…): el dato del canal puede llamarse distinto (Tamaño del colchón, Tamaño de la cama, Talla).
            const mismaMedida = medida && esDeMedida(clave) && !/paquete|package|embalaje|caja|peso|weight|largo|ancho|alto|height|width|length/.test(k);
            if (igual || mismaMedida) salida[clave] = valor;
        }
    }
    return salida;
}

const PALABRAS_SUELTAS = new Set(['disponible', 'disponibles', 'en', 'y', 'e', 'o', 'con', 'de', 'en colores']);
const aLaxo = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+').replace(/[aáàä]/gi, '[aáàä]').replace(/[eéèë]/gi, '[eéèë]').replace(/[ií]/gi, '[ií]').replace(/[oóòö]/gi, '[oóòö]').replace(/[uúü]/gi, '[uúü]').replace(/[nñ]/gi, '[nñ]');

/**
 * Quita de un título o de una descripción corta las OPCIONES de las variantes («… DISPONIBLE EN ROSADO, NEGRO, ROJO Y CREMA»).
 * El título describe el producto en general; el color o la talla los elige el comprador entre las variantes, así que no se escriben ahí.
 * Solo quita las frases «disponible en / en <valores del grupo>» y lo que sobre al final; no toca el resto del texto.
 */
export function sinOpcionesDeVariantes(texto: string, valoresDelGrupo: string[] = []): string {
    const valores = [...new Set(valoresDelGrupo.map((v) => String(v ?? '').trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
    const original = String(texto ?? '').replace(/\s+/g, ' ').trim();
    if (!valores.length || !original) return original;
    const lista = `(?:${valores.map(aLaxo).join('|')})`;
    const union = '(?:\\s*(?:,|;|/|\\by\\b|\\be\\b|\\bo\\b)\\s*)';
    const frase = new RegExp(`\\s*[,.;-]?\\s*\\b(?:disponibles?\\s+)?en\\s+(?:(?:los\\s+)?colou?res?\\s*:?\\s*)?${lista}(?:${union}${lista})*(?=[\\s.,;]|$)[.,;]?`, 'gi');
    let salida = original.replace(frase, ' ').replace(/\s+/g, ' ').trim();
    // Lo que quede colgando al final («… BOLSILLOS DISPONIBLE», «… Y»).
    const palabras = salida.split(' ').filter(Boolean);
    while (palabras.length > 1 && PALABRAS_SUELTAS.has(normalizar(palabras[palabras.length - 1].replace(/[.,;:]+$/, '')))) palabras.pop();
    salida = palabras.join(' ').replace(/[\s,;:-]+$/, '');
    return salida || original;
}
