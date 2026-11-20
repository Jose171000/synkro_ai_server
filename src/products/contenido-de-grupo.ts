/**
 * Lo que es COMÚN a todas las variantes de un grupo: la marca, la ficha HTML y la descripción en texto. (El nombre ya sale del grupo;
 * la categoría se unifica aparte.) Lo que cambia de una variante a otra —color, talla, SKU, stock, fotos, medidas propias— no entra aquí.
 *
 * Plan para dejar a las variantes con el mismo contenido que acaba de decidirse para una de ellas:
 *  - Las que aún no están publicadas en el canal se igualan.
 *  - Las ya publicadas NO se tocan (el canal ya tiene su contenido): si difieren, se avisan.
 */
export interface VarianteConContenido {
    id: string;
    /** ¿Ya está publicada (o en proceso) en el canal? */
    publicada: boolean;
    brand?: string | null;
    descriptionHtml?: string | null;
    aiDescription?: string | null;
}

export interface ContenidoComun {
    brand?: string;
    descriptionHtml?: string;
    aiDescription?: string;
}

export interface PlanDeContenido {
    /** Variantes a las que hay que escribirles estos campos (solo los que cambian). */
    actualizar: { id: string; brand?: string; descriptionHtml?: string; aiDescription?: string }[];
    /** Variantes ya publicadas cuyo contenido difiere del común: se avisan, no se cambian. */
    publicadasDistintas: string[];
}

const igual = (a: string | null | undefined, b: string | null | undefined) => String(a ?? '').trim() === String(b ?? '').trim();

export function planDeContenidoComun(familia: VarianteConContenido[], origenId: string, comun: ContenidoComun): PlanDeContenido {
    const plan: PlanDeContenido = { actualizar: [], publicadasDistintas: [] };
    for (const v of familia) {
        if (v.id === origenId) continue;
        const cambios: { brand?: string; descriptionHtml?: string; aiDescription?: string } = {};
        if (comun.brand !== undefined && !igual(v.brand, comun.brand)) cambios.brand = comun.brand;
        if (comun.descriptionHtml !== undefined && comun.descriptionHtml.trim() && !igual(v.descriptionHtml, comun.descriptionHtml)) cambios.descriptionHtml = comun.descriptionHtml;
        if (comun.aiDescription !== undefined && comun.aiDescription.trim() && !igual(v.aiDescription, comun.aiDescription)) cambios.aiDescription = comun.aiDescription;
        if (!Object.keys(cambios).length) continue;
        if (v.publicada) plan.publicadasDistintas.push(v.id);
        else plan.actualizar.push({ id: v.id, ...cambios });
    }
    return plan;
}

/** La marca más repetida entre las que acepta el canal (la primera en caso de empate); undefined si ninguna. */
export function marcaMasUsada(marcasValidas: string[]): string | undefined {
    const cuenta = new Map<string, number>();
    for (const m of marcasValidas.filter(Boolean)) cuenta.set(m, (cuenta.get(m) ?? 0) + 1);
    let mejor: string | undefined;
    for (const [m, n] of cuenta) if (!mejor || n > (cuenta.get(mejor) ?? 0)) mejor = m;
    return mejor;
}
