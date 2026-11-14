/**
 * Traduce un producto (o un grupo de variantes) de Synkro al modelo de WooCommerce. Funciones puras, sin red.
 *
 * - Un producto suelto es un producto «simple». Un grupo es UN producto «variable» y cada variante de Synkro es una variación
 *   (con su SKU, precio, stock y foto). Los ejes del grupo (Color, Talla…) pasan a ser atributos de variación.
 * - El cuerpo se crea como BORRADOR (oculto): WooPublicacionService lo publica al final, cuando ya tiene variaciones y fotos.
 * - Precio: el normal es `price`; si el producto tiene `webPrice` menor, ese va como precio de oferta.
 */

export const MAX_FOTOS_PADRE = 20;
export const MAX_FOTOS_SIMPLE = 10;

export interface ProductoParaWoo {
    id: string;
    sku: string;
    name: string;
    aiTitle?: string | null;
    description?: string | null;
    aiDescription?: string | null;
    aiAttributes?: Record<string, any> | null;
    category?: string | null;
    subCategory?: string | null;
    price: number | string | null;
    webPrice?: number | string | null;
    stock: number;
    packageWidth?: number | null;
    packageLength?: number | null;
    packageHeight?: number | null;
    packageWeight?: number | string | null;
    images?: { url: string }[] | null;
    variantValues?: Record<string, string> | null;
}

export interface GrupoParaWoo {
    name: string;
    axes: { name: string; values: string[] }[];
}

export interface DimensionesWoo { length: string; width: string; height: string }

export interface PreciosWoo { regular_price: string; sale_price: string }

export interface CuerpoDeVariacion {
    sku: string;
    regular_price: string;
    sale_price: string;
    manage_stock: true;
    stock_quantity: number;
    stock_status: 'instock' | 'outofstock';
    attributes: { name: string; option: string }[];
    image?: { src: string };
    weight?: string;
    dimensions?: DimensionesWoo;
}

export interface VariacionDelPlan {
    productId: string;
    sku: string;
    body: CuerpoDeVariacion;
}

export interface PlanWoo {
    tipo: 'simple' | 'variable';
    /** Cuerpo del producto (padre en un grupo). Siempre con status «draft». La categoría la elige aparte WooCategoriasService. */
    producto: Record<string, any>;
    variaciones: VariacionDelPlan[];
}

export class PlanInvalido extends Error { }

const limpio = (v: unknown) => String(v ?? '').trim();
const clave = (v: unknown) => limpio(v).toLowerCase();
const dinero = (n: number) => n.toFixed(2);

/** Solo direcciones https, sin repetir y con tope: WooCommerce descarga cada foto desde su dirección. */
export function fotosHttps(producto: Pick<ProductoParaWoo, 'images'>, max = MAX_FOTOS_SIMPLE): string[] {
    const vistas = new Set<string>();
    for (const imagen of producto.images ?? []) {
        const url = limpio(imagen?.url);
        if (/^https:\/\//i.test(url)) vistas.add(url);
    }
    return [...vistas].slice(0, max);
}

/** Precio normal y, si hay un precio web menor, el de oferta. */
export function preciosDe(producto: Pick<ProductoParaWoo, 'price' | 'webPrice' | 'sku'>): PreciosWoo {
    const regular = Number(producto.price);
    if (!(regular > 0)) throw new PlanInvalido(`${limpio(producto.sku)}: WooCommerce necesita un precio y este producto no tiene.`);
    const web = Number(producto.webPrice);
    return { regular_price: dinero(regular), sale_price: web > 0 && web < regular ? dinero(web) : '' };
}

/** Descripción para la tienda: la ficha HTML de la agencia si existe; si no, el texto de IA o el original (con saltos de línea). */
export function descripcionParaWoo(producto: Pick<ProductoParaWoo, 'aiAttributes' | 'aiDescription' | 'description'>): string {
    const html = limpio((producto.aiAttributes as any)?.descriptionHtml);
    if (html) return html;
    const texto = limpio(producto.aiDescription) || limpio(producto.description);
    if (/<\s*(p|br|ul|ol|li|table|div|h[1-6]|strong|b)\b/i.test(texto)) return texto;
    return texto.replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${escapar(p).replace(/\n/g, '<br>')}</p>`).join('');
}

const escapar = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Peso (kg) y medidas (cm) solo si están todos los datos que WooCommerce usa para calcular el envío. */
export function pesoYMedidas(p: Pick<ProductoParaWoo, 'packageWeight' | 'packageWidth' | 'packageLength' | 'packageHeight'>): { weight?: string; dimensions?: DimensionesWoo } {
    const salida: { weight?: string; dimensions?: DimensionesWoo } = {};
    const peso = Number(p.packageWeight);
    if (peso > 0) salida.weight = String(peso);
    const largo = Number(p.packageLength);
    const ancho = Number(p.packageWidth);
    const alto = Number(p.packageHeight);
    if (largo > 0 && ancho > 0 && alto > 0) salida.dimensions = { length: String(largo), width: String(ancho), height: String(alto) };
    return salida;
}

const stockDe = (stock: number) => Math.max(0, Math.trunc(Number(stock) || 0));
const estadoDeStock = (stock: number): 'instock' | 'outofstock' => (stockDe(stock) > 0 ? 'instock' : 'outofstock');

export function planificarWoo(variantes: ProductoParaWoo[], grupo?: GrupoParaWoo | null): PlanWoo {
    if (!variantes.length) throw new PlanInvalido('No hay productos para publicar en WooCommerce.');
    const primero = variantes[0];
    const esGrupo = !!grupo && grupo.axes.length > 0 && variantes.length > 0;

    const skus = new Set<string>();
    for (const v of variantes) {
        const sku = limpio(v.sku);
        if (!sku) throw new PlanInvalido('Hay un producto sin SKU: WooCommerce lo necesita para enlazarlo.');
        if (skus.has(clave(sku))) throw new PlanInvalido(`El SKU ${sku} está repetido dentro del grupo.`);
        skus.add(clave(sku));
    }

    const titulo = (esGrupo ? limpio(grupo!.name) : '') || limpio(primero.aiTitle) || limpio(primero.name);
    if (!titulo) throw new PlanInvalido('El producto no tiene nombre.');

    const base = {
        name: titulo,
        status: 'draft',
        description: descripcionParaWoo(primero),
        catalog_visibility: 'visible',
    };

    if (!esGrupo) {
        const precios = preciosDe(primero);
        const fotos = fotosHttps(primero, MAX_FOTOS_SIMPLE);
        return {
            tipo: 'simple',
            variaciones: [],
            producto: {
                ...base,
                type: 'simple',
                sku: limpio(primero.sku),
                ...precios,
                manage_stock: true,
                stock_quantity: stockDe(primero.stock),
                stock_status: estadoDeStock(primero.stock),
                ...pesoYMedidas(primero),
                images: fotos.map((src) => ({ src })),
            },
        };
    }

    // Atributos: los ejes del grupo, solo con los valores que alguna variante usa de verdad.
    const atributos = grupo!.axes
        .map((eje) => {
            const nombre = limpio(eje.name);
            const valores = new Map<string, string>();
            for (const v of variantes) {
                const valor = limpio(v.variantValues?.[eje.name]);
                if (valor && !valores.has(clave(valor))) valores.set(clave(valor), valor);
            }
            return { nombre, eje: eje.name, valores: [...valores.values()] };
        })
        .filter((a) => a.nombre && a.valores.length);
    if (!atributos.length) throw new PlanInvalido('Ninguna variante tiene valores en los ejes del grupo.');

    const combinaciones = new Set<string>();
    const variaciones = variantes.map((v): VariacionDelPlan => {
        const sku = limpio(v.sku);
        const precios = preciosDe(v);
        const attrs = atributos.map((a) => {
            const valor = limpio(v.variantValues?.[a.eje]);
            if (!valor) throw new PlanInvalido(`${sku}: falta el valor de «${a.nombre}».`);
            return { name: a.nombre, option: a.valores.find((x) => clave(x) === clave(valor))! };
        });
        const llave = attrs.map((x) => `${clave(x.name)}=${clave(x.option)}`).join('|');
        if (combinaciones.has(llave)) throw new PlanInvalido(`Dos variantes tienen la misma combinación (${attrs.map((x) => x.option).join(' / ')}).`);
        combinaciones.add(llave);
        const foto = fotosHttps(v, 1)[0];
        return {
            productId: v.id,
            sku,
            body: {
                sku,
                ...precios,
                manage_stock: true,
                stock_quantity: stockDe(v.stock),
                stock_status: estadoDeStock(v.stock),
                attributes: attrs,
                ...(foto ? { image: { src: foto } } : {}),
                ...pesoYMedidas(v),
            },
        };
    });

    // Fotos del producto padre: primero la principal de cada variante (así se ve cada color) y luego el resto.
    const principales = variantes.map((v) => fotosHttps(v, 1)[0]).filter((u): u is string => !!u);
    const resto = variantes.flatMap((v) => fotosHttps(v, MAX_FOTOS_SIMPLE));
    const fotosPadre = [...new Set([...principales, ...resto])].slice(0, MAX_FOTOS_PADRE);

    return {
        tipo: 'variable',
        variaciones,
        producto: {
            ...base,
            type: 'variable',
            attributes: atributos.map((a, i) => ({ name: a.nombre, position: i, visible: true, variation: true, options: a.valores })),
            images: fotosPadre.map((src) => ({ src })),
        },
    };
}
