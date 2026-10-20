/**
 * Construcción del XML que Falabella espera para crear o actualizar productos.
 *
 * La API recibe un `<Request>` con uno o varios `<Product>` dentro. Enviar de
 * a uno no es viable: pasadas 50 llamadas, cada acción de feed exige 2 minutos
 * de espera, así que Falabella pide lotes de 500 a 1000 productos por envío.
 *
 * Docs: https://developers.falabella.com/reference/productcreate
 */

/** Lo mínimo que Falabella exige para dar de alta un producto. */
export interface FalabellaProductInput {
    sellerSku: string;
    name: string;
    description: string;
    brand: string;
    primaryCategory: number | string;
    price: number;
    stock: number;
    /** Alto, ancho y largo del paquete en centímetros. */
    packageWidth: number;
    packageLength: number;
    packageHeight: number;
    /** Peso del paquete en kilos. */
    packageWeight: number;
    conditionType?: string;
    /** EAN/UPC, si se conoce. */
    productId?: string;
    /** Para variantes: mismo ParentSku en todo el grupo. */
    parentSku?: string;
    /**
     * Nombre de la variante. Muchas categorías lo exigen aunque el producto
     * no tenga variantes; en ese caso vale un valor único como el propio SKU.
     */
    variation?: string;
    status?: 'active' | 'inactive';
    /** Promoción: precio con descuento y fechas «AAAA-MM-DD». Solo se envía si es menor que el precio. */
    salePrice?: number | null;
    saleStart?: string | null;
    saleEnd?: string | null;
    /** Atributos propios de la categoría (Model, ProductionCountry, Material...). */
    extraAttributes?: Record<string, string | number | undefined | null>;
}

export interface BuildOptions {
    /**
     * Código del operador. Es el país: `fape` en Perú, `facl` en Chile.
     * El ejemplo de la documentación usa el chileno, así que conviene
     * pasarlo siempre explícito.
     */
    operatorCode: string;
}

/** Escapa los cinco caracteres que romperían el XML. */
export function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * La descripción admite HTML, así que va dentro de CDATA en lugar de
 * escaparse: si no, las etiquetas llegarían como texto visible.
 *
 * El único peligro dentro de CDATA es la secuencia `]]>`, que lo cerraría
 * antes de tiempo; se parte en dos bloques para neutralizarla.
 */
export function cdata(value: string): string {
    return `<![CDATA[${value.replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

export interface Promocion {
    salePrice?: number | string | null;
    saleStart?: string | null;
    saleEnd?: string | null;
}

/** «AAAA-MM-DD» (o una fecha ISO completa) → «AAAA-MM-DD»; cualquier otra cosa → null. */
export function fechaDeFalabella(valor: string | Date | null | undefined): string | null {
    if (!valor) return null;
    const t = valor instanceof Date ? valor.toISOString() : String(valor).trim();
    const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** La promoción vigente de un producto, o null si no tiene una válida (descuento menor que el precio, fechas en orden). */
export function promocionValida(price: number, promo: Promocion): { salePrice: number; start: string | null; end: string | null } | null {
    const sale = Number(promo.salePrice);
    if (!Number.isFinite(sale) || sale <= 0 || !(sale < Number(price))) return null;
    const start = fechaDeFalabella(promo.saleStart);
    const end = fechaDeFalabella(promo.saleEnd);
    if (start && end && end < start) return null;
    return { salePrice: Math.round(sale * 100) / 100, start, end };
}

/** Etiquetas de precio de la unidad de negocio: el regular y, si hay, el descuento con sus fechas. */
function preciosXml(price: number, promo: Promocion): string {
    const p = promocionValida(price, promo);
    return tag('Price', Number(price).toFixed(2)) +
        (p ? tag('SpecialPrice', p.salePrice.toFixed(2)) + tag('SpecialFromDate', p.start) + tag('SpecialToDate', p.end) : '');
}

/** Una etiqueta simple. Las vacías se omiten: Falabella ignora las que no traen valor. */
function tag(name: string, value: string | number | undefined | null): string {
    if (value === undefined || value === null || value === '') return '';
    return `<${name}>${escapeXml(String(value))}</${name}>`;
}

function buildProduct(product: FalabellaProductInput, options: BuildOptions): string {
    const businessUnit = [
        tag('OperatorCode', options.operatorCode),
        preciosXml(product.price, { salePrice: product.salePrice, saleStart: product.saleStart, saleEnd: product.saleEnd }),
        tag('Stock', Math.max(0, Math.trunc(product.stock))),
        tag('Status', product.status ?? 'active'),
    ].join('');

    const extras = Object.entries(product.extraAttributes ?? {})
        .map(([name, value]) => tag(name, value))
        .join('');

    const productData = [
        tag('ConditionType', product.conditionType ?? 'Nuevo'),
        tag('PackageWidth', Math.trunc(product.packageWidth)),
        tag('PackageLength', Math.trunc(product.packageLength)),
        tag('PackageHeight', Math.trunc(product.packageHeight)),
        tag('PackageWeight', product.packageWeight),
        extras,
    ].join('');

    return [
        '<Product>',
        tag('SellerSku', product.sellerSku),
        tag('Name', product.name),
        tag('ParentSku', product.parentSku),
        tag('Variation', product.variation),
        tag('ProductId', product.productId),
        `<Description>${cdata(product.description)}</Description>`,
        tag('Brand', product.brand),
        tag('PrimaryCategory', product.primaryCategory),
        `<BusinessUnits><BusinessUnit>${businessUnit}</BusinessUnit></BusinessUnits>`,
        `<ProductData>${productData}</ProductData>`,
        '</Product>',
    ].join('');
}

/** XML completo de un lote de productos. */
export function buildProductFeedXml(products: FalabellaProductInput[], options: BuildOptions): string {
    const cuerpo = products.map(product => buildProduct(product, options)).join('');
    return `<?xml version="1.0" encoding="UTF-8"?><Request>${cuerpo}</Request>`;
}

/**
 * Parte una lista larga en lotes.
 * Falabella recomienda entre 500 y 1000 productos por envío.
 */
export function chunkProducts<T>(items: T[], size = 500): T[][] {
    const lotes: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        lotes.push(items.slice(i, i + size));
    }
    return lotes;
}

/**
 * XML para cambiar solo el precio de una ficha ya publicada (ProductUpdate).
 * Va dentro de la unidad de negocio, igual que en el alta: es donde Falabella
 * guarda precio y stock, no en la raíz del producto.
 */
export function buildPriceUpdateXml(
    items: { sellerSku: string; price: number; salePrice?: number | null; saleStart?: string | null; saleEnd?: string | null }[],
    options: BuildOptions,
): string {
    const cuerpo = items
        .map(item =>
            '<Product>' +
            tag('SellerSku', item.sellerSku) +
            '<BusinessUnits><BusinessUnit>' +
            tag('OperatorCode', options.operatorCode) +
            preciosXml(item.price, item) +
            '</BusinessUnit></BusinessUnits>' +
            '</Product>')
        .join('');
    return `<?xml version="1.0" encoding="UTF-8"?><Request>${cuerpo}</Request>`;
}

/**
 * XML para cambiar el stock de fichas ya publicadas (UpdateStock).
 * Es otro formato que el del alta: va dentro de <Warehouse> con <Quantity>, sin
 * unidad de negocio. Con una sola bodega no se manda ninguna (usa la principal).
 * https://developers.falabella.com/docs/products/updatestock
 */
export function buildStockUpdateXml(items: { sellerSku: string; quantity: number }[]): string {
    const cuerpo = items
        .map(item =>
            '<Stock>' +
            tag('SellerSku', item.sellerSku) +
            `<Quantity>${Math.max(0, Math.trunc(item.quantity))}</Quantity>` +
            '</Stock>')
        .join('');
    return `<?xml version="1.0" encoding="UTF-8"?><Request><Warehouse>${cuerpo}</Warehouse></Request>`;
}

/**
 * XML para asignar las fotos de fichas ya creadas (acción Image). El alta de producto no lleva
 * imágenes: sin este paso Falabella rechaza la ficha en su control de calidad.
 * Admite hasta 8 fotos por producto, con direcciones https.
 */
export function buildImageFeedXml(items: { sellerSku: string; urls: string[] }[]): string {
    const cuerpo = items
        .map(item => {
            const urls = item.urls.filter(u => /^https?:\/\//i.test(u)).slice(0, 8);
            return (
                '<ProductImage>' +
                tag('SellerSku', item.sellerSku) +
                '<Images>' + urls.map(u => tag('Image', u)).join('') + '</Images>' +
                '</ProductImage>'
            );
        })
        .join('');
    return `<?xml version="1.0" encoding="UTF-8"?><Request>${cuerpo}</Request>`;
}

/**
 * XML para cambiar el contenido de fichas ya publicadas (ProductUpdate): nombre, descripción, marca y
 * los atributos de la categoría. No toca precio, stock ni categoría.
 */
export function buildContentUpdateXml(products: FalabellaProductInput[], options: BuildOptions = { operatorCode: 'fape' }): string {
    const cuerpo = products
        .map(p => {
            const extras = Object.entries(p.extraAttributes ?? {}).map(([name, value]) => tag(name, value)).join('');
            const productData = [
                tag('ConditionType', p.conditionType ?? 'Nuevo'),
                tag('PackageWidth', Math.trunc(p.packageWidth)),
                tag('PackageLength', Math.trunc(p.packageLength)),
                tag('PackageHeight', Math.trunc(p.packageHeight)),
                tag('PackageWeight', p.packageWeight),
                extras,
            ].join('');
            return [
                '<Product>',
                tag('SellerSku', p.sellerSku),
                tag('Name', p.name),
                `<Description>${cdata(p.description)}</Description>`,
                tag('Brand', p.brand),
                // Falabella rechaza el ProductUpdate sin unidad de negocio («BusinessUnits is missing»); basta con operador y precio.
                `<BusinessUnits><BusinessUnit>${tag('OperatorCode', options.operatorCode)}${preciosXml(p.price, { salePrice: p.salePrice, saleStart: p.saleStart, saleEnd: p.saleEnd })}</BusinessUnit></BusinessUnits>`,
                `<ProductData>${productData}</ProductData>`,
                '</Product>',
            ].join('');
        })
        .join('');
    return `<?xml version="1.0" encoding="UTF-8"?><Request>${cuerpo}</Request>`;
}
