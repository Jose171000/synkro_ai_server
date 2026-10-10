/**
 * Convierte las publicaciones de Mercado Libre en filas «una por SKU», que es
 * como las usa Synkro: un producto = un SKU.
 *
 * Una publicación de ML puede tener variantes (talla, color...) y cada una con
 * su propio SKU y su propio stock. Cada variante se trata como un producto
 * distinto del catálogo, enlazado a la misma publicación.
 *
 * Son funciones puras y tolerantes: ML no manda todos los campos siempre.
 */

export interface MeliListingRow {
    sku: string;
    /** Id de la publicación, por ejemplo MPE123456. */
    externalId: string;
    /** Id de la variante dentro de la publicación; null si no tiene variantes. */
    variationId: string | null;
    title: string;
    /** Descripción de la variante («Talla: M · Color: Rojo»). */
    variation: string | null;
    regularPrice: number | null;
    salePrice: number | null;
    stock: number;
    status: 'published' | 'paused' | 'pending' | 'error';
    permalink: string | null;
    imageUrl: string | null;
    images: string[];
    /** Nota de calidad de 0 a 100 (la «salud» de la publicación en ML). */
    quality: number | null;
    currency: string | null;
}

const texto = (v: any): string | null => {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s ? s : null;
};

const numero = (v: any): number | null => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/**
 * Mercado Libre (o las herramientas que publican en él) añade a veces un código
 * propio al final del SKU: «140-001-271_AZUL__32141126». El SKU real es lo que
 * hay antes del «__<números>».
 */
export function limpiarSkuMeli(sku: string | null | undefined): string | null {
    const s = texto(sku);
    if (!s) return null;
    return s.replace(/__\d+$/, '') || s;
}

/** El SKU puede estar en el campo antiguo o en el atributo SELLER_SKU. */
function skuDe(origen: any): string | null {
    const atributo = (origen?.attributes ?? []).find((a: any) => a?.id === 'SELLER_SKU');
    return limpiarSkuMeli(texto(origen?.seller_custom_field) ?? texto(atributo?.value_name));
}

/** Estado de Synkro a partir del de Mercado Libre. */
export function estadoDeItemMeli(item: any): MeliListingRow['status'] {
    const estado = String(item?.status ?? '').toLowerCase();
    const sub = (Array.isArray(item?.sub_status) ? item.sub_status : []).join(' ').toLowerCase();

    // Una publicación bloqueada o infractora no la compra nadie: no se muestra como viva.
    if (/forbidden|suspended|banned|blocked|infraction|moderat/.test(`${estado} ${sub}`)) return 'error';
    if (estado === 'active') return 'published';
    if (estado === 'paused' || estado === 'closed' || estado === 'inactive') return 'paused';
    return 'pending'; // under_review, payment_required...
}

export function filasDeItemMeli(item: any): { rows: MeliListingRow[]; sinSku: number } {
    const externalId = texto(item?.id);
    if (!externalId) return { rows: [], sinSku: 0 };

    const imagenes: any[] = Array.isArray(item?.pictures) ? item.pictures : [];
    const urlDe = (p: any) => texto(p?.secure_url) ?? texto(p?.url);
    const todas = imagenes.map(urlDe).filter((u): u is string => !!u);
    const porId = new Map<string, string>();
    for (const p of imagenes) {
        const url = urlDe(p);
        if (p?.id && url) porId.set(String(p.id), url);
    }
    const miniatura = texto(item?.secure_thumbnail) ?? texto(item?.thumbnail);

    const salud = numero(item?.health);
    const calidad = salud === null ? null : Math.max(0, Math.min(100, Math.round(salud * 100)));

    // Con promoción, ML manda el precio de lista en original_price y el que se cobra en price.
    const original = numero(item?.original_price);
    const precio = numero(item?.price);
    const enOferta = original !== null && precio !== null && original > precio;
    const base = {
        externalId,
        title: texto(item?.title) ?? externalId,
        status: estadoDeItemMeli(item),
        permalink: texto(item?.permalink),
        quality: calidad,
        currency: texto(item?.currency_id),
    };

    const variantes: any[] = Array.isArray(item?.variations) ? item.variations : [];
    if (!variantes.length) {
        const sku = skuDe(item);
        if (!sku) return { rows: [], sinSku: 1 };
        return {
            sinSku: 0,
            rows: [{
                ...base,
                sku,
                variationId: null,
                variation: null,
                regularPrice: enOferta ? original : precio,
                salePrice: enOferta ? precio : null,
                stock: numero(item?.available_quantity) ?? 0,
                imageUrl: todas[0] ?? miniatura,
                images: todas,
            }],
        };
    }

    const rows: MeliListingRow[] = [];
    let sinSku = 0;
    for (const v of variantes) {
        const sku = skuDe(v);
        if (!sku) { sinSku++; continue; }

        const propias = (Array.isArray(v?.picture_ids) ? v.picture_ids : [])
            .map((id: any) => porId.get(String(id)))
            .filter((u: string | undefined): u is string => !!u);
        const descripcion = (Array.isArray(v?.attribute_combinations) ? v.attribute_combinations : [])
            .map((a: any) => [texto(a?.name), texto(a?.value_name)].filter(Boolean).join(': '))
            .filter(Boolean)
            .join(' · ') || null;

        const precioVar = numero(v?.price) ?? precio;
        const originalVar = numero(v?.original_price) ?? original;
        const ofertaVar = originalVar !== null && precioVar !== null && originalVar > precioVar;

        rows.push({
            ...base,
            sku,
            variationId: texto(v?.id),
            variation: descripcion,
            regularPrice: ofertaVar ? originalVar : precioVar,
            salePrice: ofertaVar ? precioVar : null,
            stock: numero(v?.available_quantity) ?? 0,
            imageUrl: propias[0] ?? todas[0] ?? miniatura,
            images: propias.length ? propias : todas,
        });
    }
    return { rows, sinSku };
}
