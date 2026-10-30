import { FalabellaProduct } from './falabella/falabella-api.service';
import { ATRIBUTOS_DE_SISTEMA, claveDeAtributo } from './falabella/falabella-fields';

/**
 * Lo que un canal ya tiene de un producto al importarlo (descripción, marca, atributos) y cómo se guarda en Synkro sin pisar nada:
 *  - una copia de referencia por canal (aiAttributes._importado.<canal>) que no se envía a ninguna parte: sirve para comparar,
 *    para que la IA parta de lo real y para recuperar el original si algún día se pisa;
 *  - los campos generales (descripción HTML, descripción en texto, marca, atributos) solo se rellenan si estaban vacíos.
 */

export type CanalDeImportacion = 'falabella' | 'mercadolibre';

export interface ContenidoDeCanal {
    name: string;
    /** Falabella manda HTML; Mercado Libre, texto plano. */
    description: string;
    brand: string;
    /** Falabella: por nombre del campo (ProductData); Mercado Libre: por id del atributo. */
    atributos: Record<string, string>;
}

const texto = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
const vacio = (v: unknown) => texto(v) === '';
export const pareceHtml = (t: string) => /<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i.test(t);

/** Lo que trae la ficha de Falabella. Todo es opcional: no siempre llega completo. */
export function contenidoDeFichaFalabella(ficha: FalabellaProduct): ContenidoDeCanal {
    const atributos: Record<string, string> = {};
    for (const [nombre, valor] of Object.entries(ficha?.ProductData ?? {})) {
        const v = texto(valor);
        if (v && !ATRIBUTOS_DE_SISTEMA.has(nombre)) atributos[nombre] = v;
    }
    return { name: texto(ficha?.Name), description: texto(ficha?.Description), brand: texto(ficha?.Brand), atributos };
}

/** Lo que trae una publicación de Mercado Libre; la descripción llega aparte (otra consulta). */
export function contenidoDeItemMeli(item: any, descripcion?: string | null): ContenidoDeCanal {
    const atributos: Record<string, string> = {};
    for (const a of Array.isArray(item?.attributes) ? item.attributes : []) {
        const id = texto(a?.id);
        const valor = texto(a?.value_name);
        if (id && valor && id !== 'SELLER_SKU') atributos[id] = valor;
    }
    return { name: texto(item?.title), description: texto(descripcion), brand: atributos.BRAND ?? '', atributos };
}

/** ¿La ficha trae algo que importar? Sirve para contar, en la vista previa, qué se traería. */
export function resumenDeContenido(c: ContenidoDeCanal) {
    return { descripcion: !!c.description, marca: !!c.brand, atributos: Object.keys(c.atributos).length };
}

/**
 * Guarda en el producto lo que el canal tenía. Devuelve si cambió algo.
 * Lo que ya tiene valor no se toca; la copia de referencia se guarda una sola vez, la primera que se importa, para que una
 * importación posterior no la reemplace por lo que Synkro mandó después.
 */
export function aplicarContenidoImportado(
    product: { aiDescription?: string | null; aiAttributes?: any },
    canal: CanalDeImportacion,
    c: ContenidoDeCanal,
    ahora: Date = new Date(),
): boolean {
    // Si el canal no trae nada que importar no se guarda ni una copia vacía: no hay nada que comparar ni recuperar.
    if (!c.description && !c.brand && !Object.keys(c.atributos).length) return false;

    const attrs: Record<string, any> = { ...(product.aiAttributes || {}) };
    let cambio = false;

    const importado: Record<string, any> = { ...(attrs._importado ?? {}) };
    if (!importado[canal]) {
        importado[canal] = { name: c.name, description: c.description, brand: c.brand, attributes: c.atributos, importedAt: ahora.toISOString() };
        attrs._importado = importado;
        cambio = true;
    }

    if (c.description) {
        if (pareceHtml(c.description)) {
            if (vacio(attrs.descriptionHtml)) { attrs.descriptionHtml = c.description; cambio = true; }
        } else if (vacio(product.aiDescription)) {
            product.aiDescription = c.description;
            cambio = true;
        }
    }

    if (c.brand && vacio(attrs.brand)) { attrs.brand = c.brand; cambio = true; }

    if (canal === 'falabella') {
        // Los atributos de Falabella se leen por nombre, desde la raíz; uno ya presente (aunque se escriba distinto) no se pisa.
        const presentes = new Set(Object.keys(attrs).filter((k) => !vacio(attrs[k])).map(claveDeAtributo));
        for (const [nombre, valor] of Object.entries(c.atributos)) {
            if (presentes.has(claveDeAtributo(nombre))) continue;
            attrs[nombre] = valor;
            cambio = true;
        }
    } else {
        const previos: Record<string, any> = { ...(attrs.mercadolibre_attributes ?? {}) };
        for (const [id, valor] of Object.entries(c.atributos)) {
            if (!vacio(previos[id])) continue;
            previos[id] = valor;
            cambio = true;
        }
        if (Object.keys(previos).length) attrs.mercadolibre_attributes = previos;
    }

    if (cambio) product.aiAttributes = attrs;
    return cambio;
}
