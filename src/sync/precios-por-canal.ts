import { promocionValida } from './falabella/falabella-product-xml';

/** Lo que un enlace sabe de precios: lo que la persona fijó para ese canal y lo que el canal muestra hoy. */
export interface PreciosDelEnlace {
    priceOverride?: number | string | null;
    salePriceOverride?: number | string | null;
    saleStartOverride?: string | null;
    saleEndOverride?: string | null;
    /** Descuento que el canal muestra ahora (leído en la última importación o revisión). */
    salePrice?: number | string | null;
}

export interface PreciosDelProducto {
    price: number | string | null;
    salePrice?: number | string | null;
    saleStartDate?: string | null;
    saleEndDate?: string | null;
}

export type OrigenDePrecio = 'propio' | 'producto' | 'canal';

export interface PreciosParaCanal {
    price: number;
    promo: { salePrice: number; start: string | null; end: string | null } | null;
    origen: { price: OrigenDePrecio; promo: OrigenDePrecio | null };
}

/**
 * Los precios que se envían a UN canal. Cada dato sale del primero que lo tenga:
 *  1. lo que la persona fijó para ese canal,
 *  2. lo del producto (igual para todos los canales),
 *  3. para el descuento, lo que el canal ya muestra: así un envío de contenido nunca quita un descuento que el canal tenía.
 */
export function preciosParaCanal(product: PreciosDelProducto, enlace?: PreciosDelEnlace | null): PreciosParaCanal {
    const propioPrecio = enlace?.priceOverride !== null && enlace?.priceOverride !== undefined && Number(enlace.priceOverride) > 0;
    const price = propioPrecio ? Number(enlace!.priceOverride) : Number(product.price);

    const propia = promocionValida(price, { salePrice: enlace?.salePriceOverride, saleStart: enlace?.saleStartOverride, saleEnd: enlace?.saleEndOverride });
    if (propia) return { price, promo: propia, origen: { price: propioPrecio ? 'propio' : 'producto', promo: 'propio' } };

    const delProducto = promocionValida(price, { salePrice: product.salePrice, saleStart: product.saleStartDate, saleEnd: product.saleEndDate });
    if (delProducto) return { price, promo: delProducto, origen: { price: propioPrecio ? 'propio' : 'producto', promo: 'producto' } };

    const delCanal = promocionValida(price, { salePrice: enlace?.salePrice });
    return {
        price,
        promo: delCanal,
        origen: { price: propioPrecio ? 'propio' : 'producto', promo: delCanal ? 'canal' : null },
    };
}

/** Firma de una promoción para saber si cambió respecto a la última enviada. */
export function firmaDePromo(promo: PreciosParaCanal['promo']): string {
    return promo ? `${promo.salePrice}|${promo.start ?? ''}|${promo.end ?? ''}` : '';
}
