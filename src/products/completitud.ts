/**
 * Qué le falta a un producto y en qué estado está en cada canal, dicho igual en la lista de productos, en el detalle de
 * completitud y en la exportación. Las reglas básicas (foto, precio, descripción, categoría) son las mismas que usa el
 * filtro «Incompletos» de la lista.
 */

interface ProductoParaRevisar {
    name?: string | null;
    description?: string | null;
    category?: string | null;
    price?: number | string | null;
    stock?: number | null;
    images?: { url: string }[] | null;
    marketplaceIds?: Record<string, any> | null;
    aiAttributes?: Record<string, any> | null;
}

interface EnlaceParaMostrar {
    marketplace: string;
    syncStatus: string;
    pausedByUser?: boolean;
}

const NOMBRES: Record<string, string> = { mercadolibre: 'Mercado Libre', falabella: 'Falabella', shopify: 'Shopify', woocommerce: 'WooCommerce', yavendio: 'Yavendio' };

export const nombreDeCanal = (marketplace: string): string => NOMBRES[marketplace] ?? marketplace;

const ESTADOS: Record<string, string> = { published: 'Publicado', pending: 'En proceso', paused: 'Pausado', error: 'Error', removed: 'Retirado' };

export function estadoDeCanal(enlace: EnlaceParaMostrar): string {
    // Una ficha de Falabella pausada con stock 0 puede figurar «publicada» en el canal: manda lo que decidió el usuario.
    if (enlace.pausedByUser && enlace.syncStatus === 'published') return ESTADOS.paused;
    return ESTADOS[enlace.syncStatus] ?? enlace.syncStatus;
}

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** La categoría que el producto tiene en algún canal (o la interna), con su id y el canal al que pertenece. */
export function categoriasAsignadas(p: ProductoParaRevisar): { falabella: string | null; mercadolibre: string | null; interna: string | null } {
    const ids = p.marketplaceIds ?? {};
    const ai = p.aiAttributes ?? {};
    return {
        falabella: texto(ids.falabella_category_id) || texto(ai.falabella_category_id) || null,
        mercadolibre: texto(ids.mercadolibre_category_id) || texto(ai.mercadolibre_category_id) || null,
        interna: texto(p.category) || null,
    };
}

/** Datos básicos que faltan para poder publicar en cualquier canal. */
export function datosQueFaltan(p: ProductoParaRevisar): string[] {
    const faltan: string[] = [];
    if (!(p.images ?? []).some((i) => texto(i?.url))) faltan.push('fotos');
    if (p.price === null || p.price === undefined || p.price === '') faltan.push('precio');
    if (p.stock === null || p.stock === undefined) faltan.push('stock');
    if (!texto(p.description)) faltan.push('descripción');
    const c = categoriasAsignadas(p);
    if (!c.falabella && !c.mercadolibre && !c.interna) faltan.push('categoría');
    return faltan;
}
