import { descripcionEnTextoPlano } from '../meli/descripcion-meli';

/** Límites de la API de Yavendió (v1.15.0). */
export const MAX_NOMBRE = 250;
export const MAX_DESCRIPCION = 500;
export const MAX_SKU = 100;
export const MAX_FOTOS_POR_VARIANTE = 8;

/** Todo producto de Yavendió necesita al menos una opción con un valor: los productos simples usan esta. */
export const OPCION_SIMPLE = { name: 'Presentación', value: 'Estándar' };

export interface ProductoParaYavendio {
    id: string;
    sku: string;
    name: string;
    aiTitle?: string | null;
    description?: string | null;
    aiDescription?: string | null;
    price: number | string | null;
    stock: number;
    images?: { url: string }[] | null;
    variantValues?: Record<string, string> | null;
}

export interface GrupoParaYavendio {
    name: string;
    axes: { name: string; values: string[] }[];
}

export interface VarianteDelPlan {
    productId: string;
    /**
     * SKU de Synkro. Yavendió no lo usa para identificar nada: el vínculo es el enlace interno (producto de Synkro ↔
     * id de producto y de variante en Yavendió). No se escribe en Yavendió; solo sirve para mensajes y para validar.
     */
    sku: string;
    name: string;
    price: number;
    status: 'available' | 'not_available';
    /** Un valor por opción: así se traducen a ids al crear la variante. */
    optionValues: { option: string; value: string }[];
    images: string[];
}

export interface PlanYavendio {
    name: string;
    description: string;
    options: { name: string; values: string[] }[];
    variants: VarianteDelPlan[];
}

export class PlanInvalido extends Error { }

const limpio = (v: unknown) => String(v ?? '').trim();
const clave = (v: string) => limpio(v).toLowerCase();

/** Descripción de Yavendió: texto simple de hasta 500 caracteres, cortado en una palabra completa. */
export function descripcionParaYavendio(html: string | null | undefined): string {
    const texto = descripcionEnTextoPlano(html).replace(/\s*\n\s*/g, '\n');
    if (texto.length <= MAX_DESCRIPCION) return texto;
    const corte = texto.slice(0, MAX_DESCRIPCION - 1);
    const ultimoEspacio = corte.search(/\s\S*$/);
    return (ultimoEspacio > MAX_DESCRIPCION * 0.6 ? corte.slice(0, ultimoEspacio) : corte).trimEnd() + '…';
}

/** Disponibilidad: Yavendió no tiene campo de stock en su API; Synkro manda y solo dice si hay o no. */
export const estadoDeVariante = (stock: number, pausadoPorElUsuario = false): 'available' | 'not_available' =>
    !pausadoPorElUsuario && Number(stock) > 0 ? 'available' : 'not_available';

function fotosHttps(producto: ProductoParaYavendio): string[] {
    const vistas = new Set<string>();
    for (const imagen of producto.images ?? []) {
        const url = limpio(imagen?.url);
        if (/^https:\/\//i.test(url)) vistas.add(url);
    }
    return [...vistas].slice(0, MAX_FOTOS_POR_VARIANTE);
}

/**
 * Traduce un producto (o un grupo de variantes) al modelo de Yavendió: producto → opciones → variantes → fotos.
 * `variantes` son todas las variantes del grupo (o el producto suelto). No llama a ninguna API.
 */
export function planificarYavendio(variantes: ProductoParaYavendio[], grupo?: GrupoParaYavendio | null): PlanYavendio {
    if (!variantes.length) throw new PlanInvalido('No hay productos para publicar en Yavendió.');
    const primero = variantes[0];
    const titulo = limpio(grupo?.name) || limpio(primero.aiTitle) || limpio(primero.name);
    if (!titulo) throw new PlanInvalido('El producto no tiene nombre.');

    const esGrupo = !!grupo && grupo.axes.length > 0;
    // Opciones: las del grupo, solo con los valores que alguna variante usa de verdad.
    const options = esGrupo
        ? grupo!.axes
            .map((eje) => ({
                name: limpio(eje.name),
                values: [...new Map(variantes.map((v) => [clave(v.variantValues?.[eje.name] ?? ''), limpio(v.variantValues?.[eje.name])]).filter(([k]) => k) as [string, string][]).values()],
            }))
            .filter((o) => o.name && o.values.length)
        : [{ name: OPCION_SIMPLE.name, values: [OPCION_SIMPLE.value] }];

    if (esGrupo && !options.length) throw new PlanInvalido('Ninguna variante tiene valores en los ejes del grupo.');

    const skus = new Set<string>();
    const planes = variantes.map((v): VarianteDelPlan => {
        const sku = limpio(v.sku);
        if (sku.length > MAX_SKU) throw new PlanInvalido(`El SKU ${sku} supera los ${MAX_SKU} caracteres que acepta Yavendió.`);
        if (skus.has(clave(sku))) throw new PlanInvalido(`El SKU ${sku} está repetido dentro del grupo.`);
        skus.add(clave(sku));

        const precio = Number(v.price);
        if (!(precio > 0)) throw new PlanInvalido(`${sku}: Yavendió exige precio y este producto no tiene.`);

        const optionValues = esGrupo
            ? options.map((o) => {
                const eje = grupo!.axes.find((e) => limpio(e.name) === o.name)!;
                const valor = limpio(v.variantValues?.[eje.name]);
                if (!valor) throw new PlanInvalido(`${sku}: falta el valor de «${o.name}».`);
                return { option: o.name, value: o.values.find((x) => clave(x) === clave(valor))! };
            })
            : [{ option: OPCION_SIMPLE.name, value: OPCION_SIMPLE.value }];

        const nombre = esGrupo ? `${titulo} - ${optionValues.map((o) => o.value).join(' / ')}` : titulo;
        return {
            productId: v.id,
            sku,
            name: nombre.slice(0, MAX_NOMBRE),
            price: precio,
            status: estadoDeVariante(v.stock),
            optionValues,
            images: fotosHttps(v),
        };
    });

    // Dos variantes con la misma combinación no se pueden distinguir en Yavendió.
    const combinaciones = new Set<string>();
    for (const p of planes) {
        const llave = p.optionValues.map((o) => `${clave(o.option)}=${clave(o.value)}`).join('|');
        if (combinaciones.has(llave)) throw new PlanInvalido(`Dos variantes tienen la misma combinación (${p.optionValues.map((o) => o.value).join(' / ')}).`);
        combinaciones.add(llave);
    }

    return {
        name: titulo.slice(0, MAX_NOMBRE),
        description: descripcionParaYavendio(primero.aiDescription || primero.description),
        options,
        variants: planes,
    };
}
