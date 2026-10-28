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

const claveLaxa = (t: string) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Los atributos del producto con los valores de ESTA variante por encima de los del molde: el color del producto base
 * («Azul») no debe ganarle al de la variante («Negro»). Solo se reemplaza lo que ya existe; en el color también el color básico.
 */
export function atributosConVariante(atributos: Record<string, any>, valores?: Record<string, string> | null): Record<string, any> {
    const salida: Record<string, any> = { ...(atributos ?? {}) };
    for (const [eje, valor] of Object.entries(valores ?? {})) {
        const ejeLaxo = claveLaxa(eje);
        const iguales = ejeLaxo === 'color' ? [ejeLaxo, 'colorbasico', 'maincolor'] : ejeLaxo === 'talla' ? [ejeLaxo, 'size'] : [ejeLaxo];
        for (const clave of Object.keys(salida)) {
            if (iguales.includes(claveLaxa(clave))) salida[clave] = valor;
        }
    }
    return salida;
}
