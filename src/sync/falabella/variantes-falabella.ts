import { FalabellaProduct, imagenesDeFicha } from './falabella-api.service';
import { EjeDeVariacion } from '../../products/entities/product-group.entity';
import { MAX_EJES, MAX_VARIANTES, claveDeCombinacion, normalizar } from '../../products/variantes';

/**
 * Cómo se agrupan en Synkro las fichas de Falabella que son variantes de un mismo producto.
 *
 * En Falabella cada variante es una ficha con su propio SKU, sus propias fotos y el mismo `ParentSku`. Lo que las
 * distingue está en los atributos de cada ficha (Color, Talla, Plazas…). Aquí se decide, SIN inventar nada:
 *  - qué fichas forman un grupo (las que comparten `ParentSku` y son al menos dos);
 *  - cuáles son los ejes: atributos de variación que todas las fichas del grupo tienen y que cambian entre ellas;
 *  - el valor de cada eje en cada variante, tal como lo escribió el vendedor.
 * Si las variantes no se pueden distinguir con certeza, el grupo no se arma y se explica por qué.
 */

export interface PlanDeGrupo {
    parentSku: string;
    name: string;
    axes: EjeDeVariacion[];
    variants: { sellerSku: string; values: Record<string, string> }[];
    /** De dónde salieron los ejes: los atributos de las fichas o la página pública de Falabella. */
    origen?: 'atributos' | 'pagina' | 'ia' | 'manual';
}

export interface GrupoSinResolver {
    parentSku: string;
    skus: string[];
    motivo: string;
    /** Qué traen las primeras fichas (variación y atributos), para entender por qué no se pudo resolver. */
    pistas?: { sellerSku: string; variation: string | null; atributos: Record<string, string> }[];
    /** Las fichas de la familia (SKU y título), para estructurarlas a mano. */
    fichas?: { sku: string; nombre: string; /** Foto principal de la ficha: ayuda a decidir el valor de cada variante. */ imagen: string | null }[];
    /** Dirección de la publicación en el canal, para abrirla y corregirla allí (cuando no hay nada que estructurar aquí). */
    enlace?: string | null;
    /** Título de la publicación. */
    titulo?: string;
    /** Lo que propuso la IA y no se pudo comprobar: sirve de sugerencia al estructurar a mano. */
    sugerencia?: { ejes: string[]; valores: Record<string, Record<string, string>>; motivo: string };
}

/** Atributos de texto corto de una ficha, para mostrar en una pista (sin descripciones largas). */
function atributosCortos(f: FalabellaProduct): Record<string, string> {
    const salida: Record<string, string> = {};
    for (const [k, v] of Object.entries(f.ProductData ?? {})) {
        if ((typeof v === 'string' || typeof v === 'number') && String(v).length <= 40 && Object.keys(salida).length < 40) salida[k] = String(v);
    }
    return salida;
}

export const fichasDe = (fichas: FalabellaProduct[]) => fichas.slice(0, 100).map((f) => ({ sku: String(f.SellerSku).trim(), nombre: String(f.Name ?? '').slice(0, 160), imagen: imagenesDeFicha(f)[0] ?? null }));

const pistasDe = (fichas: FalabellaProduct[]) =>
    fichas.slice(0, 3).map((f) => ({ sellerSku: String(f.SellerSku).trim(), variation: f.Variation ? String(f.Variation).slice(0, 60) : null, atributos: atributosCortos(f) }));

/** Atributos que suelen ser el eje de variación, en el orden en que se prefieren, y el nombre con que se muestran. */
const FAMILIAS: { nombre: string; patron: RegExp }[] = [
    { nombre: 'Color', patron: /color|colour/ },
    { nombre: 'Talla', patron: /talla|size|numerodecalzado|calzado/ },
    { nombre: 'Plazas', patron: /plaza/ },
    { nombre: 'Tamaño', patron: /tamano|medida|dimension/ },
    { nombre: 'Capacidad', patron: /capacidad|capacity/ },
    { nombre: 'Modelo', patron: /modelo|model/ },
    { nombre: 'Personaje', patron: /personaje|character/ },
    { nombre: 'Diseño', patron: /diseno|estampado|pattern/ },
    { nombre: 'Sabor', patron: /sabor|flavor/ },
    { nombre: 'Aroma', patron: /aroma|fragancia/ },
    { nombre: 'Presentación', patron: /presentacion/ },
    { nombre: 'Material', patron: /material/ },
    { nombre: 'Forma', patron: /forma$|shape/ },
];

const clave = (t: unknown) => normalizar(t).replace(/[^a-z0-9]/g, '');
const texto = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().replace(/\s+/g, ' ').slice(0, 60) : '');

interface Candidato {
    nombre: string;
    prioridad: number;
    porSku: Map<string, string>;
    distintos: number;
}

/** Los atributos de la ficha que pueden ser un eje, con el valor de cada ficha; solo los que TODAS tienen y que cambian. */
function candidatosDeEje(fichas: FalabellaProduct[]): Candidato[] {
    const claves = new Set<string>();
    for (const f of fichas) for (const k of Object.keys(f.ProductData ?? {})) claves.add(k);

    const mejorPorFamilia = new Map<number, Candidato>();
    for (const k of claves) {
        const familia = FAMILIAS.findIndex((fam) => fam.patron.test(clave(k)));
        if (familia < 0) continue;
        const porSku = new Map<string, string>();
        for (const f of fichas) {
            const v = texto((f.ProductData ?? {})[k]);
            if (!v) break;
            porSku.set(String(f.SellerSku).trim(), v);
        }
        if (porSku.size !== fichas.length) continue; // alguna ficha no lo tiene: no sirve como eje
        const distintos = new Set([...porSku.values()].map(normalizar)).size;
        if (distintos < 2) continue; // todas lo tienen igual: no distingue nada
        const actual = mejorPorFamilia.get(familia);
        if (!actual || distintos > actual.distintos) mejorPorFamilia.set(familia, { nombre: FAMILIAS[familia].nombre, prioridad: familia, porSku, distintos });
    }
    return [...mejorPorFamilia.values()].sort((a, b) => a.prioridad - b.prioridad);
}

function ejeDe(c: { nombre: string; porSku: Map<string, string> }, orden: string[]): EjeDeVariacion {
    const vistos = new Set<string>();
    const values: string[] = [];
    for (const sku of orden) {
        const v = c.porSku.get(sku)!;
        if (!vistos.has(normalizar(v))) { vistos.add(normalizar(v)); values.push(v); }
    }
    return { name: c.nombre, values };
}

/** Nombre del grupo: lo que comparten los títulos de las variantes; si no comparten, el del primero sin sus valores. */
export function nombreDelGrupo(fichas: FalabellaProduct[], ejes: EjeDeVariacion[], valoresDelPrimero: Record<string, string>, parentSku: string): string {
    const palabras = fichas.map((f) => String(f.Name ?? '').trim().split(/\s+/).filter(Boolean));
    let comun = 0;
    while (palabras.every((p) => p[comun] && normalizar(p[comun]) === normalizar(palabras[0][comun]))) comun++;
    if (comun >= 2) return palabras[0].slice(0, comun).join(' ').replace(/[\s\-–,:|/]+$/g, '').slice(0, 250);

    let nombre = String(fichas[0].Name ?? '');
    for (const e of ejes) {
        const v = valoresDelPrimero[e.name];
        if (v) nombre = nombre.replace(new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'ig'), ' ');
    }
    nombre = nombre.replace(/\s+/g, ' ').replace(/^[\s\-–,:|/]+|[\s\-–,:|/]+$/g, '').trim();
    return (nombre.length >= 3 ? nombre : String(fichas[0].Name ?? parentSku)).slice(0, 250) || parentSku;
}

export function planearGruposDeFalabella(productos: FalabellaProduct[]): { grupos: PlanDeGrupo[]; sinResolver: GrupoSinResolver[] } {
    const porPadre = new Map<string, FalabellaProduct[]>();
    const vistos = new Set<string>();
    for (const p of productos ?? []) {
        const sku = String(p?.SellerSku ?? '').trim();
        const padre = String(p?.ParentSku ?? '').trim();
        if (!sku || !padre || vistos.has(sku)) continue;
        vistos.add(sku);
        porPadre.set(padre, [...(porPadre.get(padre) ?? []), p]);
    }

    const grupos: PlanDeGrupo[] = [];
    const sinResolver: GrupoSinResolver[] = [];
    for (const [parentSku, fichas] of porPadre) {
        if (fichas.length < 2) continue; // Falabella pone ParentSku = SellerSku a los productos sueltos
        const skus = fichas.map((f) => String(f.SellerSku).trim());
        if (fichas.length > MAX_VARIANTES) { sinResolver.push({ parentSku, skus, motivo: `tiene más de ${MAX_VARIANTES} variantes`, fichas: fichasDe(fichas) }); continue; }

        const candidatos = candidatosDeEje(fichas).slice(0, MAX_EJES);
        const ejesBase = candidatos.map((c) => ejeDe(c, skus));
        const porEje = candidatos.map((c) => ({ nombre: c.nombre, porSku: c.porSku }));

        // La variación que escribe el vendedor sirve de eje cuando los atributos no alcanzan para distinguirlas.
        let ejes = ejesBase;
        let fuentes = porEje;
        const valoresDe = (sku: string) => Object.fromEntries(fuentes.map((f) => [f.nombre, f.porSku.get(sku)!]));
        const claveDe = (sku: string) => claveDeCombinacion(Object.fromEntries(ejes.map((e) => [e.name, e.values.find((v) => normalizar(v) === normalizar(valoresDe(sku)[e.name]))!])), ejes);
        const sonUnicas = () => ejes.length > 0 && new Set(skus.map(claveDe)).size === skus.length;

        if (!sonUnicas() && ejes.length < MAX_EJES) {
            const variacion = new Map<string, string>();
            for (const f of fichas) { const v = texto(f.Variation); if (v) variacion.set(String(f.SellerSku).trim(), v); }
            if (variacion.size === fichas.length && new Set([...variacion.values()].map(normalizar)).size >= 2) {
                const extra = { nombre: 'Variación', porSku: variacion };
                const ejeExtra = ejeDe(extra, skus);
                const antes = { ejes, fuentes };
                ejes = [...ejes, ejeExtra];
                fuentes = [...fuentes, extra];
                if (!sonUnicas()) { ejes = antes.ejes; fuentes = antes.fuentes; }
            }
        }

        if (!sonUnicas()) {
            sinResolver.push({ parentSku, skus, motivo: 'no se pudo determinar en qué se diferencian (color, talla…): revisa los atributos de variación en Falabella', pistas: pistasDe(fichas), fichas: fichasDe(fichas) });
            continue;
        }

        const variants = skus.map((sku) => ({
            sellerSku: sku,
            values: Object.fromEntries(ejes.map((e) => [e.name, e.values.find((v) => normalizar(v) === normalizar(valoresDe(sku)[e.name]))!])),
        }));
        grupos.push({ parentSku, name: nombreDelGrupo(fichas, ejes, variants[0].values, parentSku), axes: ejes, variants });
    }
    return { grupos, sinResolver };
}
