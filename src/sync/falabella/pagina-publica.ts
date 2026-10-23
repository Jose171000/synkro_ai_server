import { FalabellaProduct } from './falabella-api.service';
import { EjeDeVariacion } from '../../products/entities/product-group.entity';
import { MAX_EJES, MAX_VARIANTES, claveDeCombinacion, normalizar } from '../../products/variantes';
import { PlanDeGrupo } from './variantes-falabella';

/**
 * Variantes tal como las muestra la página pública de Falabella. Falabella junta en una sola página las fichas que
 * son variantes de un producto, y esa página trae por variante el color y la talla reales y el SKU del vendedor.
 *
 * Es una fuente NO oficial: si Falabella cambia la página, aquí no se adivina nada. El lector exige la forma exacta que
 * necesita (variantes con atributos y SKU del vendedor); si falta algo devuelve `ok: false` con el motivo, y esas
 * familias siguen por la revisión manual.
 */

export interface VarianteDePagina {
    variantId: string;
    /** SKU del vendedor de cada oferta de la variante (puede haber ofertas de otros vendedores). */
    sellerSkus: string[];
    size: string | null;
    colorName: string | null;
    colorCode: string | null;
}

export interface LecturaDePagina {
    ok: boolean;
    motivo?: string;
    productId?: string;
    nombre?: string;
    /** Ruta de categoría que muestra la página, de la más específica a la más general. */
    categoria?: { ruta: string[]; codigo: string | null };
    variantes: VarianteDePagina[];
}

const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, 80) : null);

/** Identificador del producto en la dirección pública: …/product/153461795/nombre/153461796 → 153461795. */
export function idDeProductoEnUrl(url: string | null | undefined): string | null {
    const m = String(url ?? '').match(/\/product\/(\d+)\//);
    return m ? m[1] : null;
}

/** Busca el objeto del producto (el que tiene `variants`) sin depender de la ruta exacta dentro de los datos de la página. */
function buscarProducto(nodo: any, profundidad = 0): any | null {
    if (!nodo || typeof nodo !== 'object' || profundidad > 6) return null;
    if (Array.isArray(nodo.variants) && nodo.variants.length && nodo.variants.every((v: any) => v && typeof v === 'object' && 'attributes' in v && 'offerings' in v)) return nodo;
    for (const valor of Object.values(nodo)) {
        const hallado = buscarProducto(valor, profundidad + 1);
        if (hallado) return hallado;
    }
    return null;
}

export function leerPaginaPublica(html: string): LecturaDePagina {
    const vacio = (motivo: string): LecturaDePagina => ({ ok: false, motivo, variantes: [] });
    if (!html || typeof html !== 'string') return vacio('la página llegó vacía');

    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return vacio('la página no trae los datos esperados (puede estar bloqueada o haber cambiado)');

    let datos: any;
    try { datos = JSON.parse(m[1]); } catch { return vacio('los datos de la página no se pudieron leer'); }

    const producto = buscarProducto(datos?.props?.pageProps ?? datos);
    if (!producto) return vacio('la página no trae las variantes con la forma esperada');

    const variantes: VarianteDePagina[] = [];
    for (const v of producto.variants) {
        const ofertas = Array.isArray(v.offerings) ? v.offerings : [];
        const sellerSkus = ofertas.map((o: any) => texto(o?.sellerSkuId)).filter((x: string | null): x is string => !!x);
        const a = v.attributes && typeof v.attributes === 'object' ? v.attributes : {};
        variantes.push({
            variantId: String(v.id ?? ''),
            sellerSkus,
            size: texto(a.size),
            colorName: texto(a.colorName) ?? texto(String(a.primaryColor ?? '').split('|')[0]),
            colorCode: texto(a.colorCode),
        });
    }
    // Sin SKU del vendedor no hay forma segura de emparejar la variante con un producto de Synkro.
    if (!variantes.some((v) => v.sellerSkus.length)) return vacio('las variantes de la página no traen el SKU del vendedor');

    const ruta = Array.isArray(producto.breadCrumb) ? producto.breadCrumb.map((b: any) => texto(b?.label ?? b?.name)).filter((x: string | null): x is string => !!x) : [];
    return {
        ok: true,
        productId: texto(String(producto.id ?? '')) ?? undefined,
        nombre: texto(producto.name) ?? undefined,
        categoria: { ruta, codigo: texto(producto.attributes?.GSCCategoryId) },
        variantes,
    };
}

/** «SKU · BL-A6-F-VC» y «BL-A6-F-VC» son el mismo SKU: se compara sin el prefijo «SKU ·». */
export const skuComparable = (sku: string): string => normalizar(sku).replace(/^sku\s*[·:.\-]*\s*/, '').replace(/\s+/g, '');

export interface FamiliaDePagina {
    productId: string;
    url: string;
    fichas: FalabellaProduct[];
}

/** Las fichas que Falabella junta en una misma página pública (mismo producto en la dirección), de dos en adelante. */
export function familiasPorPagina(productos: FalabellaProduct[]): FamiliaDePagina[] {
    const porId = new Map<string, FamiliaDePagina>();
    for (const p of productos ?? []) {
        const id = idDeProductoEnUrl(p?.Url);
        if (!id || !String(p?.SellerSku ?? '').trim()) continue;
        const f = porId.get(id) ?? { productId: id, url: String(p.Url), fichas: [] };
        f.fichas.push(p);
        porId.set(id, f);
    }
    return [...porId.values()].filter((f) => f.fichas.length >= 2);
}

export interface PlanDesdePagina {
    plan: PlanDeGrupo | null;
    motivo?: string;
}

/**
 * Arma el grupo con lo que dice la página: el eje Color sale de `colorName` y el eje Talla de `size`, solo si cambian
 * entre las variantes y TODAS las fichas de la familia tienen valor. Si no se pueden emparejar todas las fichas o las
 * combinaciones se repiten, no se arma el grupo.
 */
export function planearGrupoDesdePagina(familia: FamiliaDePagina, lectura: LecturaDePagina, nombreDelGrupo: string, parentSku: string): PlanDesdePagina {
    if (!lectura.ok) return { plan: null, motivo: lectura.motivo };
    if (familia.fichas.length > MAX_VARIANTES) return { plan: null, motivo: `tiene más de ${MAX_VARIANTES} variantes` };

    const porSku = new Map<string, VarianteDePagina>();
    for (const v of lectura.variantes) for (const s of v.sellerSkus) porSku.set(skuComparable(s), v);

    const emparejadas = familia.fichas.map((f) => ({ sku: String(f.SellerSku).trim(), variante: porSku.get(skuComparable(String(f.SellerSku))) }));
    const sinPar = emparejadas.filter((e) => !e.variante);
    if (sinPar.length) return { plan: null, motivo: `la página no incluye ${sinPar.length === 1 ? 'el SKU' : 'los SKU'} ${sinPar.slice(0, 3).map((e) => e.sku).join(', ')}` };

    const ejes: { nombre: string; valor: (v: VarianteDePagina) => string | null }[] = [
        { nombre: 'Color', valor: (v) => v.colorName },
        { nombre: 'Talla', valor: (v) => v.size },
    ];
    const elegidos = ejes
        .filter((e) => emparejadas.every((x) => !!e.valor(x.variante!)) && new Set(emparejadas.map((x) => normalizar(e.valor(x.variante!)))).size >= 2)
        .slice(0, MAX_EJES);
    if (!elegidos.length) return { plan: null, motivo: 'la página no distingue las variantes por color ni talla' };

    const axes: EjeDeVariacion[] = elegidos.map((e) => {
        const vistos = new Set<string>();
        const values: string[] = [];
        for (const x of emparejadas) { const v = e.valor(x.variante!)!; if (!vistos.has(normalizar(v))) { vistos.add(normalizar(v)); values.push(v); } }
        return { name: e.nombre, values };
    });
    const variants = emparejadas.map((x) => ({
        sellerSku: x.sku,
        values: Object.fromEntries(elegidos.map((e, i) => [e.nombre, axes[i].values.find((v) => normalizar(v) === normalizar(e.valor(x.variante!)))!])),
    }));
    if (new Set(variants.map((v) => claveDeCombinacion(v.values, axes))).size !== variants.length) return { plan: null, motivo: 'dos variantes tienen el mismo color y talla en la página' };

    return { plan: { parentSku, name: nombreDelGrupo, axes, variants, origen: 'pagina' } };
}
