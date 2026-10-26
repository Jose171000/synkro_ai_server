import { EjeDeVariacion } from '../../products/entities/product-group.entity';
import { MAX_EJES, MAX_VARIANTES, claveDeCombinacion, normalizar } from '../../products/variantes';
import { GrupoSinResolver, PlanDeGrupo } from '../falabella/variantes-falabella';
import { FalabellaProduct } from '../falabella/falabella-api.service';
import { filasDeItemMeli, OpcionesDeFilasMeli } from './meli-listings';

/**
 * Familias de Mercado Libre: en su modelo nuevo cada color o talla es una publicación aparte, y las publicaciones que son
 * variantes de un mismo producto comparten `family_id` y `family_name`. Aquí se agrupan en Synkro como un producto con
 * variantes.
 *
 * El eje sale de los atributos de cada publicación que TODAS tienen y que cambian entre ellas (COLOR, tamaño…). Si Mercado
 * Libre dice cuáles atributos de la categoría admiten variación, solo cuentan esos. Lo que no se pueda decidir con
 * certeza no se agrupa: pasa a la IA y, por último, a la revisión manual.
 */

/** Atributos que cambian entre publicaciones pero no distinguen variantes (códigos, estado, textos de ayuda). */
const NO_SON_EJES = new Set(['SELLER_SKU', 'GTIN', 'EAN', 'UPC', 'ISBN', 'EMPTY_GTIN_REASON', 'ITEM_CONDITION', 'PACKAGE_WEIGHT', 'PACKAGE_LENGTH', 'PACKAGE_WIDTH', 'PACKAGE_HEIGHT']);
/** Cuando Mercado Libre no informa cuáles atributos admiten variación, se aceptan solo estos. */
const EJES_HABITUALES = /^(COLOR|SIZE|MATTRESS_SIZE|BED_SIZE|MODEL|CAPACITY|FLAVOR|SCENT|MATERIAL|STYLE|DESIGN|FABRIC_DESIGN|PIECES_NUMBER|SHOE_SIZE|CLOTHING_SIZE)$/;
const PRIORIDAD = ['COLOR', 'SIZE', 'MATTRESS_SIZE', 'BED_SIZE', 'SHOE_SIZE', 'CLOTHING_SIZE'];

const texto = (v: unknown): string | null => {
    if (v === undefined || v === null) return null;
    const s = String(v).trim().replace(/\s+/g, ' ');
    return s ? s.slice(0, 60) : null;
};

interface AtributoDeItem { nombre: string; valor: string }

function atributosDe(item: any): Map<string, AtributoDeItem> {
    const salida = new Map<string, AtributoDeItem>();
    for (const a of Array.isArray(item?.attributes) ? item.attributes : []) {
        const id = texto(a?.id);
        const valor = texto(a?.value_name);
        if (id && valor) salida.set(id, { nombre: texto(a?.name) ?? id, valor });
    }
    return salida;
}

export interface ResultadoDeFamilias {
    grupos: PlanDeGrupo[];
    sinResolver: GrupoSinResolver[];
    /** Las publicaciones de las familias sin resolver, con la forma que espera la IA (SKU, título, atributos). */
    paraLaIA: FalabellaProduct[];
}

/**
 * @param variacionPorCategoria  por cada categoría, los atributos que Mercado Libre admite como variación (si se conocen).
 */
export function planearFamiliasDeMeli(items: any[], variacionPorCategoria: Map<string, Set<string>> = new Map(), opciones: OpcionesDeFilasMeli = {}): ResultadoDeFamilias {
    const grupos: PlanDeGrupo[] = [];
    const sinResolver: GrupoSinResolver[] = [];
    const paraLaIA: FalabellaProduct[] = [];

    // Publicaciones simples (sin variaciones propias) agrupadas por familia.
    const familias = new Map<string, { nombre: string | null; items: any[] }>();
    for (const item of items ?? []) {
        const familia = texto(item?.family_id);
        if (!familia || (Array.isArray(item?.variations) && item.variations.length)) continue;
        const f = familias.get(familia) ?? { nombre: texto(item?.family_name), items: [] };
        f.items.push(item);
        familias.set(familia, f);
    }

    for (const [familiaId, fam] of familias) {
        // Una fila por publicación, con su SKU limpio y su foto; las que no tienen SKU no se pueden enlazar.
        const filas = fam.items
            .map((item) => ({ item, fila: filasDeItemMeli(item, opciones).rows[0], atributos: atributosDe(item) }))
            .filter((x) => !!x.fila);
        if (filas.length < 2) continue;

        const parentSku = `FAM-${familiaId}`;
        const nombreDelGrupo = (fam.nombre ?? filas[0].fila.title).slice(0, 250);
        const resumenDeFichas = () => filas.slice(0, MAX_VARIANTES).map((x) => ({ sku: x.fila.sku, nombre: x.fila.title.slice(0, 160), imagen: x.fila.imageUrl }));
        const falla = (motivo: string) => {
            sinResolver.push({ parentSku, skus: filas.map((x) => x.fila.sku), motivo, fichas: resumenDeFichas() });
            for (const x of filas) {
                paraLaIA.push({
                    SellerSku: x.fila.sku,
                    Name: x.fila.title,
                    ProductData: Object.fromEntries([...x.atributos.entries()].map(([id, a]) => [id, a.valor])),
                } as FalabellaProduct);
            }
        };

        if (filas.length > MAX_VARIANTES) { falla(`tiene más de ${MAX_VARIANTES} publicaciones`); continue; }

        // Atributos que todas tienen y que cambian; si Mercado Libre dice cuáles admiten variación, solo esos.
        const categoria = texto(filas[0].item?.category_id);
        const admitidos = categoria ? variacionPorCategoria.get(categoria) : undefined;
        const ids = [...new Set(filas.flatMap((x) => [...x.atributos.keys()]))];
        let candidatos = ids.filter((id) => !NO_SON_EJES.has(id)
            && filas.every((x) => x.atributos.has(id))
            && new Set(filas.map((x) => normalizar(x.atributos.get(id)!.valor))).size >= 2
            && (admitidos && admitidos.size ? admitidos.has(id) : EJES_HABITUALES.test(id)));
        // COLOR describe lo mismo que MAIN_COLOR pero con más detalle: no se usan los dos como ejes.
        if (candidatos.includes('COLOR')) candidatos = candidatos.filter((id) => id !== 'MAIN_COLOR');
        candidatos.sort((a, b) => {
            const pa = PRIORIDAD.indexOf(a); const pb = PRIORIDAD.indexOf(b);
            return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb) || a.localeCompare(b);
        });
        if (!candidatos.length) { falla('las publicaciones de la familia no se distinguen por color, talla ni otro atributo'); continue; }
        if (candidatos.length > MAX_EJES) { falla(`se distinguen por más de ${MAX_EJES} atributos (${candidatos.slice(0, 5).join(', ')})`); continue; }

        const axes: EjeDeVariacion[] = candidatos.map((id) => {
            const vistos = new Set<string>();
            const values: string[] = [];
            for (const x of filas) { const v = x.atributos.get(id)!.valor; if (!vistos.has(normalizar(v))) { vistos.add(normalizar(v)); values.push(v); } }
            return { name: filas[0].atributos.get(id)!.nombre, values };
        });
        const variants = filas.map((x) => ({
            sellerSku: x.fila.sku,
            values: Object.fromEntries(candidatos.map((id, i) => [axes[i].name, axes[i].values.find((v) => normalizar(v) === normalizar(x.atributos.get(id)!.valor))!])),
        }));
        if (new Set(variants.map((v) => claveDeCombinacion(v.values, axes))).size !== variants.length) { falla('dos publicaciones quedarían con la misma combinación'); continue; }

        grupos.push({ parentSku, name: nombreDelGrupo, axes, variants, origen: 'atributos' });
    }
    return { grupos, sinResolver, paraLaIA };
}
