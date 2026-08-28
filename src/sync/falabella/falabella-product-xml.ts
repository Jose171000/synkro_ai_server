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
    status?: 'active' | 'inactive';
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

/** Una etiqueta simple. Las vacías se omiten: Falabella ignora las que no traen valor. */
function tag(name: string, value: string | number | undefined | null): string {
    if (value === undefined || value === null || value === '') return '';
    return `<${name}>${escapeXml(String(value))}</${name}>`;
}

function buildProduct(product: FalabellaProductInput, options: BuildOptions): string {
    const businessUnit = [
        tag('OperatorCode', options.operatorCode),
        tag('Price', product.price.toFixed(2)),
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
