/**
 * Elegir la categoría de WooCommerce de un producto entre las que YA existen en la tienda (nunca se crean categorías solas).
 * Funciones puras, sin red. Primero se busca por texto; si no hay una respuesta clara, decide la IA (solo entre esta lista).
 */

/** Dónde se guarda la categoría elegida de cada tienda: aiAttributes._wooCategorias[idDeLaCuenta] = { id, ruta, origen }. */
export const CLAVE_CATEGORIAS_WOO = '_wooCategorias';

export interface CategoriaWoo {
    id: number;
    name: string;
    parent: number;
    count?: number;
    slug?: string;
}

export interface CategoriaConRuta {
    id: number;
    nombre: string;
    /** «Hogar › Cama › Sábanas». */
    ruta: string;
    profundidad: number;
    /** Cuántos productos tiene hoy: ante un empate, la más usada. */
    cantidad: number;
}

export interface TextoDelProducto {
    categoria?: string | null;
    subcategoria?: string | null;
    titulo: string;
}

export type OrigenDeCategoria = 'guardada' | 'texto' | 'ia' | 'manual';

const decodificar = (s: string) => String(s ?? '').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

export const normalizar = (s: unknown): string =>
    decodificar(String(s ?? '')).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ]+/g, ' ').trim();

const PALABRAS_VACIAS = new Set(['y', 'e', 'de', 'del', 'la', 'el', 'los', 'las', 'para', 'con', 'en', 'a', 'o', 'u', 'por', 'sin']);

/** «Sábanas» y «sabana» son la misma palabra: se compara sin tildes y en singular. */
function raiz(palabra: string): string {
    let p = palabra;
    if (p.length > 4 && p.endsWith('es')) p = p.slice(0, -2);
    else if (p.length > 3 && p.endsWith('s')) p = p.slice(0, -1);
    return p;
}

export function palabrasDe(texto: unknown): string[] {
    return normalizar(texto).split(' ').filter((w) => w && !PALABRAS_VACIAS.has(w)).map(raiz);
}

/** La que WordPress usa cuando no se elige ninguna: no sirve como destino. */
const esPorDefecto = (c: CategoriaWoo) => /^(uncategorized|sin-categoria|sin-categorizar)$/i.test(c.slug ?? '') || /^(uncategorized|sin categorizar|sin categoria)$/.test(normalizar(c.name));

/** Cada categoría con su ruta completa (de arriba hacia abajo). Ignora la categoría por defecto de WordPress. */
export function rutasDeCategorias(lista: CategoriaWoo[]): CategoriaConRuta[] {
    const porId = new Map(lista.map((c) => [c.id, c]));
    const resultado: CategoriaConRuta[] = [];
    for (const c of lista) {
        if (esPorDefecto(c)) continue;
        const nombres: string[] = [];
        const vistos = new Set<number>();
        let actual: CategoriaWoo | undefined = c;
        while (actual && !vistos.has(actual.id)) {
            vistos.add(actual.id);
            nombres.unshift(decodificar(actual.name));
            actual = actual.parent ? porId.get(actual.parent) : undefined;
        }
        resultado.push({ id: c.id, nombre: decodificar(c.name), ruta: nombres.join(' › '), profundidad: nombres.length, cantidad: Number(c.count) || 0 });
    }
    return resultado;
}

/** Ordena de la más específica a la más general y, a igual nivel, de la más usada a la menos. */
const masEspecifica = (a: CategoriaConRuta, b: CategoriaConRuta) => b.profundidad - a.profundidad || b.cantidad - a.cantidad;

/**
 * Busca la categoría sin IA:
 *  1) Si el producto ya trae categoría o subcategoría escrita, la que se llame igual (la subcategoría manda).
 *  2) Si no, la categoría cuyas palabras están TODAS en el título («Sábanas» en «Juego de Sábanas Casatex»). Gana la que cubre
 *     más palabras y, a igualdad, la más específica. Si dos ramas distintas empatan, no se decide: lo hace la IA.
 */
export function elegirPorTexto(texto: TextoDelProducto, categorias: CategoriaConRuta[]): CategoriaConRuta | null {
    if (!categorias.length) return null;

    for (const escrita of [texto.subcategoria, texto.categoria]) {
        const k = normalizar(escrita);
        if (!k) continue;
        const iguales = categorias.filter((c) => normalizar(c.nombre) === k || normalizar(c.ruta) === k).sort(masEspecifica);
        if (iguales.length) return iguales[0];
    }

    const delTitulo = new Set(palabrasDe(texto.titulo));
    if (!delTitulo.size) return null;
    const candidatas = categorias
        .map((c) => ({ c, palabras: palabrasDe(c.nombre) }))
        .filter(({ palabras }) => palabras.length && palabras.every((p) => delTitulo.has(p)))
        .map(({ c, palabras }) => ({ c, puntos: palabras.length }));
    if (!candidatas.length) return null;

    const mejor = Math.max(...candidatas.map((x) => x.puntos));
    const empatadas = candidatas.filter((x) => x.puntos === mejor).map((x) => x.c).sort(masEspecifica);
    // Varias con el mismo nombre en ramas distintas («Sábanas» en Hogar y en Bebé): no hay una respuesta clara.
    const ramas = new Set(empatadas.map((c) => c.ruta.split(' › ')[0]));
    const mismoNombre = new Set(empatadas.map((c) => normalizar(c.nombre)));
    if (empatadas.length > 1 && ramas.size > 1 && mismoNombre.size === 1) return null;
    return empatadas[0];
}

/**
 * Tiendas con cientos de categorías: a la IA no se le manda la lista entera (se pierde entre tantas y se encarece). Hasta `max` se
 * manda todo; si hay más, solo las más parecidas al producto (palabras del título y la descripción que están en el nombre de la
 * categoría o de sus padres) y, a igualdad, las que más productos tienen. Sin ninguna parecida, las más usadas.
 */
export function candidatasParaIA(texto: { titulo: string; descripcion?: string | null }, categorias: CategoriaConRuta[], max = 150): CategoriaConRuta[] {
    if (categorias.length <= max) return categorias;
    const delProducto = new Set([...palabrasDe(texto.titulo), ...palabrasDe(String(texto.descripcion ?? '').slice(0, 400))]);
    const puntuadas = categorias.map((c) => {
        const nombre = new Set(palabrasDe(c.nombre));
        const ruta = new Set(palabrasDe(c.ruta));
        let puntos = 0;
        for (const p of delProducto) {
            if (nombre.has(p)) puntos += 3; // coincide con la propia categoría
            else if (ruta.has(p)) puntos += 1; // coincide con una de sus categorías padre
        }
        return { c, puntos };
    });
    return puntuadas
        .sort((a, b) => b.puntos - a.puntos || b.c.cantidad - a.c.cantidad || a.c.ruta.localeCompare(b.c.ruta, 'es'))
        .slice(0, max)
        .map((x) => x.c);
}

/** La categoría de la lista con ese id, o null (la IA solo puede elegir una que exista). */
export const categoriaPorId = (id: unknown, categorias: CategoriaConRuta[]): CategoriaConRuta | null =>
    categorias.find((c) => c.id === Number(id)) ?? null;
