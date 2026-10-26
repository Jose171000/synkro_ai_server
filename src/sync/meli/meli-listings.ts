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
    /** Unidades vendidas de la publicación o de la variación, si Mercado Libre las informa. */
    vendidas?: number | null;
    /** Tipo de publicación (clásica, premium…) y, si Mercado Libre la marca como sincronizada, la publicación con la que lo está. */
    tipo?: string | null;
    sincronizadaCon?: string | null;
    currency: string | null;
    /** El SKU no venía de Mercado Libre: lo generó Synkro porque la persona lo pidió al importar. */
    skuGenerado?: boolean;
}

export interface OpcionesDeFilasMeli {
    /** Da un SKU propio a lo que no lo tiene en Mercado Libre. Por defecto no: lo que no tiene SKU no se importa. */
    generarSku?: boolean;
}

/** SKU que Synkro asigna a una publicación (o variación) sin SKU: siempre el mismo, para que importar de nuevo no cree duplicados. */
export function skuGeneradoMeli(externalId: string, variationId?: string | null): string {
    return variationId ? `${externalId}-${variationId}` : externalId;
}

export interface PublicacionSinSku {
    externalId: string;
    titulo: string;
    enlace: string | null;
    /** Cuántas variaciones (o 1 si es una publicación simple) no tienen SKU. */
    sinSku: number;
    /** Cuántas variaciones tiene en total (1 si es simple). */
    total: number;
}

/** Las publicaciones que tienen algo sin SKU, para que la persona sepa exactamente cuáles corregir en Mercado Libre. */
export function publicacionesSinSku(items: any[]): PublicacionSinSku[] {
    const salida: PublicacionSinSku[] = [];
    for (const item of items ?? []) {
        const externalId = texto(item?.id);
        if (!externalId) continue;
        const variaciones: any[] = Array.isArray(item?.variations) ? item.variations : [];
        const total = variaciones.length || 1;
        const sinSku = variaciones.length ? variaciones.filter((v) => !skuDe(v)).length : (skuDe(item) ? 0 : 1);
        if (!sinSku) continue;
        salida.push({ externalId, titulo: (texto(item?.title) ?? externalId).slice(0, 120), enlace: texto(item?.permalink), sinSku, total });
    }
    return salida;
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

export function filasDeItemMeli(item: any, opciones: OpcionesDeFilasMeli = {}): { rows: MeliListingRow[]; sinSku: number } {
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
    const vendidasDelItem = numero(item?.sold_quantity);
    const tipo = texto(item?.listing_type_id);
    const sincronizadaCon = texto(item?.parent_item_id);
    const base = {
        externalId,
        title: texto(item?.title) ?? externalId,
        status: estadoDeItemMeli(item),
        permalink: texto(item?.permalink),
        quality: calidad,
        currency: texto(item?.currency_id),
        tipo,
        sincronizadaCon,
    };

    const variantes: any[] = Array.isArray(item?.variations) ? item.variations : [];
    if (!variantes.length) {
        const propio = skuDe(item);
        if (!propio && !opciones.generarSku) return { rows: [], sinSku: 1 };
        const sku = propio ?? skuGeneradoMeli(externalId);
        return {
            sinSku: 0,
            rows: [{
                ...base,
                sku,
                skuGenerado: !propio,
                variationId: null,
                variation: null,
                regularPrice: enOferta ? original : precio,
                salePrice: enOferta ? precio : null,
                stock: numero(item?.available_quantity) ?? 0,
                vendidas: vendidasDelItem,
                imageUrl: todas[0] ?? miniatura,
                images: todas,
            }],
        };
    }

    const rows: MeliListingRow[] = [];
    let sinSku = 0;
    for (const v of variantes) {
        const propio = skuDe(v);
        if (!propio && !opciones.generarSku) { sinSku++; continue; }
        const sku = propio ?? skuGeneradoMeli(externalId, texto(v?.id));

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
            skuGenerado: !propio,
            variationId: texto(v?.id),
            variation: descripcion,
            regularPrice: ofertaVar ? originalVar : precioVar,
            salePrice: ofertaVar ? precioVar : null,
            stock: numero(v?.available_quantity) ?? 0,
            vendidas: numero(v?.sold_quantity) ?? vendidasDelItem,
            imageUrl: propias[0] ?? todas[0] ?? miniatura,
            images: propias.length ? propias : todas,
        });
    }
    return { rows, sinSku };
}
