import { YavendioProduct } from './yavendio-api.service';

/** Producto de Synkro que puede quedar vinculado a una variante de Yavendió. */
export interface CandidatoSynkro {
    id: string;
    sku: string;
    name: string;
    price: number | null;
    stock: number | null;
    groupName?: string | null;
    variantValues?: Record<string, string> | null;
}

export type Confianza = 'alta' | 'posible' | 'ninguna';

export interface Coincidencia {
    productId: string;
    sku: string;
    name: string;
    motivo: string;
}

export interface SugerenciaDeVariante {
    yavendioProductId: string;
    yavendioProductName: string;
    variantId: string;
    variantName: string;
    price: number | null;
    available: boolean;
    /** Ya está vinculada a un producto de Synkro. */
    vinculadaA: string | null;
    confianza: Confianza;
    sugerido: Coincidencia | null;
    otras: Coincidencia[];
    /** Cosas que cambiarían en Yavendió en el próximo envío desde Synkro. */
    avisos: string[];
}

/** Sin tildes, en minúsculas y con espacios simples: «Polo  Negro – Talla M» y «polo negro talla m» se comparan igual. */
export const normalizar = (v: unknown): string =>
    String(v ?? '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

/** Se conservan las palabras de una letra: «M» y «L» son lo único que distingue dos tallas. */
const palabras = (v: string): Set<string> => new Set(normalizar(v).split(' ').filter(Boolean));

/** Parecido entre dos textos de 0 a 1 (palabras en común sobre palabras en total). */
export function parecido(a: string, b: string): number {
    const A = palabras(a);
    const B = palabras(b);
    if (!A.size || !B.size) return 0;
    let comunes = 0;
    for (const p of A) if (B.has(p)) comunes++;
    return comunes / (A.size + B.size - comunes);
}

/** Nombres con los que Synkro reconoce a un producto: el suyo y, si es variante, «grupo - valores». */
function nombresDe(c: CandidatoSynkro): string[] {
    const nombres = [c.name];
    const valores = Object.values(c.variantValues ?? {}).filter(Boolean);
    if (c.groupName && valores.length) {
        nombres.push(`${c.groupName} - ${valores.join(' ')}`);
        nombres.push(`${c.groupName} ${valores.join(' ')}`);
    }
    return nombres;
}

const UMBRAL_POSIBLE = 0.6;

function puntuar(
    producto: YavendioProduct,
    variante: NonNullable<YavendioProduct['variants']>[number],
    c: CandidatoSynkro,
): { puntaje: number; motivo: string } {
    const unica = (producto.variants?.length ?? 0) === 1;
    const skuY = normalizar(variante.sku);
    if (skuY && skuY === normalizar(c.sku)) return { puntaje: 1, motivo: 'Mismo SKU' };

    const nombresY = [variante.name, `${producto.name} - ${variante.name}`, ...(unica ? [producto.name] : [])];
    const nombresS = nombresDe(c);

    let mejor = 0;
    let exacta = false;
    for (const y of nombresY) {
        for (const s of nombresS) {
            if (normalizar(y) && normalizar(y) === normalizar(s)) exacta = true;
            mejor = Math.max(mejor, parecido(y, s));
        }
    }
    if (exacta) return { puntaje: 0.95, motivo: 'Mismo nombre' };
    return { puntaje: mejor, motivo: `Nombre parecido (${Math.round(mejor * 100)}%)` };
}

/**
 * Propone, para cada variante de Yavendió, qué producto de Synkro es. Como Yavendió no usa SKU, se compara por SKU
 * cuando lo hay y si no por nombre. Solo es «alta» una coincidencia exacta que ningún otro competidor disputa:
 * si dos variantes apuntan al mismo producto, o dos productos empatan, queda «posible» y la decide una persona.
 */
export function sugerirVinculos(
    productosYavendio: YavendioProduct[],
    candidatos: CandidatoSynkro[],
    /** variantId de Yavendió → productId de Synkro, de lo ya vinculado en esta cuenta. */
    yaVinculadas: Map<string, string>,
): SugerenciaDeVariante[] {
    const ocupados = new Set(yaVinculadas.values());
    const libres = candidatos.filter((c) => !ocupados.has(c.id));
    const porId = new Map(candidatos.map((c) => [c.id, c]));

    const filas: (SugerenciaDeVariante & { _mejor: number; _empate: boolean })[] = [];
    for (const producto of productosYavendio) {
        for (const variante of producto.variants ?? []) {
            const precio = variante.base_price != null && variante.base_price !== '' ? Number(variante.base_price) : null;
            const vinculada = yaVinculadas.get(String(variante.id)) ?? null;
            const base = {
                yavendioProductId: String(producto.id),
                yavendioProductName: producto.name,
                variantId: String(variante.id),
                variantName: variante.name,
                price: precio !== null && Number.isFinite(precio) ? precio : null,
                available: variante.status === 'available',
                vinculadaA: vinculada ? (porId.get(vinculada)?.sku ?? vinculada) : null,
            };
            if (vinculada) {
                filas.push({ ...base, confianza: 'ninguna', sugerido: null, otras: [], avisos: [], _mejor: 0, _empate: false });
                continue;
            }

            const puntuados = libres
                .map((c) => ({ c, ...puntuar(producto, variante, c) }))
                .filter((p) => p.puntaje >= UMBRAL_POSIBLE)
                .sort((a, b) => b.puntaje - a.puntaje);
            const mejor = puntuados[0];
            const empate = !!mejor && puntuados.length > 1 && puntuados[1].puntaje === mejor.puntaje;
            const aCoincidencia = (p: (typeof puntuados)[number]): Coincidencia => ({ productId: p.c.id, sku: p.c.sku, name: p.c.name, motivo: p.motivo });

            const avisos: string[] = [];
            if (mejor) {
                const { c } = mejor;
                if (c.price !== null && base.price !== null && Math.abs(c.price - base.price) > 0.009) {
                    avisos.push(`El precio cambiaría de ${base.price.toFixed(2)} (Yavendió) a ${c.price.toFixed(2)} (Synkro) al enviar.`);
                }
                if (base.available && !(Number(c.stock) > 0)) {
                    avisos.push('En Synkro no tiene stock: al enviar, la variante quedaría «no disponible» en Yavendió.');
                }
            }

            filas.push({
                ...base,
                confianza: mejor ? (mejor.puntaje >= 0.95 && !empate ? 'alta' : 'posible') : 'ninguna',
                sugerido: mejor ? aCoincidencia(mejor) : null,
                otras: puntuados.slice(1, 4).map(aCoincidencia),
                avisos,
                _mejor: mejor?.puntaje ?? 0,
                _empate: empate,
            });
        }
    }

    // Dos variantes que quieren el mismo producto: ninguna es segura.
    const reclamos = new Map<string, number>();
    for (const f of filas) if (f.sugerido) reclamos.set(f.sugerido.productId, (reclamos.get(f.sugerido.productId) ?? 0) + 1);
    return filas.map(({ _mejor, _empate, ...f }) => {
        if (f.sugerido && (reclamos.get(f.sugerido.productId) ?? 0) > 1 && f.confianza === 'alta') return { ...f, confianza: 'posible' as const };
        return f;
    });
}
