import { NormalizedOrder } from '../order-details';

/**
 * Contrato común de los canales de tienda propia (WooCommerce, Shopify).
 *
 * Cada canal sabe hablar con su API y traducir lo que recibe a estas formas;
 * la lógica de Synkro (importar por SKU, enlazar, mantener al día, descontar
 * stock, propagarlo a los demás canales) vive una sola vez en
 * EcommerceSyncService y no sabe nada de WooCommerce ni de Shopify.
 */

/** Canales de tienda propia que habla EcommerceSyncService. */
export type EcommerceChannel = 'woocommerce' | 'shopify';

export const ECOMMERCE_CHANNELS: EcommerceChannel[] = ['woocommerce', 'shopify'];

/** Credenciales ya descifradas de una cuenta. */
export interface ChannelAuth {
    /**
     * WooCommerce: dirección de la tienda, por ejemplo https://mitienda.com
     * Shopify: dominio de la tienda, por ejemplo mitienda.myshopify.com
     */
    site: string;
    /** WooCommerce: consumer key. Shopify: token de acceso de la Admin API. */
    token: string;
    /** WooCommerce: consumer secret. Shopify: no se usa. */
    secret?: string;
}

/**
 * Una fila por SKU: así usa Synkro las publicaciones (un producto = un SKU).
 * Un producto con variantes da una fila por cada variante que tenga SKU.
 * Misma forma que las filas de Mercado Libre.
 */
export interface ChannelListingRow {
    sku: string;
    /** Id del producto en el canal. */
    externalId: string;
    /** Id de la variante dentro del producto; null si no tiene variantes. */
    variationId: string | null;
    title: string;
    /** Descripción de la variante («Talla: M · Color: Rojo»). */
    variation: string | null;
    regularPrice: number | null;
    /** Precio con descuento vigente, si lo hay. */
    salePrice: number | null;
    stock: number;
    status: 'published' | 'paused' | 'pending' | 'error';
    permalink: string | null;
    imageUrl: string | null;
    images: string[];
    currency: string | null;
}

export interface ChannelListingsResult {
    rows: ChannelListingRow[];
    /** Productos o variantes sin SKU: no se pueden enlazar. */
    sinSku: number;
    /** Productos leídos (cada uno puede dar varias filas). */
    productos: number;
    /** true si el catálogo era más grande de lo que se lee de una vez. */
    incompleto: boolean;
}

/** Una venta traducida al formato común. */
export interface ChannelOrder {
    /** Id de la venta en el canal (se usa para no registrarla dos veces). */
    externalId: string;
    /** Venta confirmada y pagada: solo estas mueven el stock. */
    paid: boolean;
    /** Estado tal como lo muestra el canal, en minúsculas. */
    channelStatus: string;
    totalAmount: number;
    currency: string | null;
    orderDate: Date;
    /** Cliente, envío, pago y líneas (sku, título, cantidad, precio) en el formato de la lista de ventas. */
    normalized: NormalizedOrder;
}

export interface ChannelOrdersQuery {
    /** Ventas creadas desde esta fecha (historial). */
    createdFrom?: Date;
    /** Ventas creadas hasta esta fecha (historial). */
    createdTo?: Date;
    /** Ventas modificadas desde esta fecha (consulta periódica: también capta las que se pagan tarde). */
    updatedFrom?: Date;
    /** Tope de ventas a leer. */
    max: number;
}

export interface ChannelOrdersResult {
    orders: ChannelOrder[];
    incompleto: boolean;
}

/** Lo que un cliente de canal entrega a EcommerceSyncService. */
export interface ChannelClient {
    readonly channel: EcommerceChannel;

    /**
     * Comprueba las credenciales contra la API y devuelve cómo identificar la
     * cuenta. Lanza un error con un mensaje claro en español si no sirven.
     */
    verify(auth: ChannelAuth): Promise<{
        /** Identificador estable de la cuenta (dirección normalizada de la tienda). */
        accountId: string;
        /** Nombre para mostrar. */
        nickname: string;
        currency: string | null;
    }>;

    /** Todo el catálogo, ya como filas por SKU. Lee por páginas y se detiene en un tope. */
    listListings(auth: ChannelAuth): Promise<ChannelListingsResult>;

    /** Cambia el stock (y el precio, si se indica) de un producto o variante. */
    setInventory(
        auth: ChannelAuth,
        target: { externalId: string; variationId: string | null },
        values: { stock: number; price?: number | null },
    ): Promise<void>;

    /** Ventas según el filtro, de la más reciente a la más antigua. */
    listOrders(auth: ChannelAuth, query: ChannelOrdersQuery): Promise<ChannelOrdersResult>;
}
