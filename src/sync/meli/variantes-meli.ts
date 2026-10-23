import { EjeDeVariacion } from '../../products/entities/product-group.entity';
import { MAX_EJES, MAX_VARIANTES, claveDeCombinacion, normalizar } from '../../products/variantes';
import { GrupoSinResolver, PlanDeGrupo } from '../falabella/variantes-falabella';
import { filasDeItemMeli, MeliListingRow } from './meli-listings';

/**
 * Cómo se agrupan en Synkro las variaciones de una publicación de Mercado Libre.
 *
 * Mercado Libre ya entrega cada variación con su eje y su valor (`attribute_combinations`: Color → Rojo, Talla → M), así
 * que aquí no se deduce nada: una publicación con dos o más variaciones con SKU es un producto con variantes, sus ejes son
 * los atributos que todas las variaciones tienen y que cambian entre ellas, y cada variante conserva sus propias fotos.
 * Si no se puede decidir con certeza (más de 3 ejes, sin atributos, combinaciones repetidas), no se agrupa y se explica.
 */

const texto = (v: unknown): string | null => {
    if (v === undefined || v === null) return null;
    const s = String(v).trim().replace(/\s+/g, ' ');
    return s ? s.slice(0, 60) : null;
};

/** Los valores de cada eje de una variación: {Color: 'Rojo', Talla: 'M'}. */
export function valoresDeVariacion(variacion: any): Record<string, string> {
    const salida: Record<string, string> = {};
    for (const a of Array.isArray(variacion?.attribute_combinations) ? variacion.attribute_combinations : []) {
        const nombre = texto(a?.name) ?? texto(a?.id);
        const valor = texto(a?.value_name);
        if (nombre && valor && !(nombre in salida)) salida[nombre] = valor;
    }
    return salida;
}

export function planearGruposDeMeli(items: any[]): { grupos: PlanDeGrupo[]; sinResolver: GrupoSinResolver[] } {
    const grupos: PlanDeGrupo[] = [];
    const sinResolver: GrupoSinResolver[] = [];

    for (const item of items ?? []) {
        const variaciones: any[] = Array.isArray(item?.variations) ? item.variations : [];
        if (variaciones.length < 2) continue; // sin variaciones es un producto simple

        const { rows } = filasDeItemMeli(item);
        const valoresPorVariacion = new Map(variaciones.map((v) => [String(v?.id), valoresDeVariacion(v)]));
        const filas: (MeliListingRow & { valores: Record<string, string> })[] = rows
            .filter((r) => r.variationId)
            .map((r) => ({ ...r, valores: valoresPorVariacion.get(String(r.variationId)) ?? {} }));
        if (filas.length < 2) {
            // Las variaciones sin SKU no se pueden enlazar con un producto de Synkro: se avisa en vez de ignorarlas.
            sinResolver.push({
                parentSku: String(item.id),
                skus: filas.map((f) => f.sku),
                motivo: `tiene ${variaciones.length} variaciones pero solo ${filas.length} con SKU: ponles un SKU a cada una en Mercado Libre para poder agruparlas`,
                enlace: texto(item.permalink),
                titulo: String(item.title ?? '').slice(0, 120),
            });
            continue;
        }

        const parentSku = String(item.id);
        const falla = (motivo: string) => sinResolver.push({
            parentSku,
            skus: filas.map((f) => f.sku),
            motivo,
            fichas: filas.slice(0, 100).map((f) => ({ sku: f.sku, nombre: [f.title, f.variation].filter(Boolean).join(' - ').slice(0, 160), imagen: f.imageUrl })),
        });

        if (filas.length > MAX_VARIANTES) { falla(`tiene más de ${MAX_VARIANTES} variaciones`); continue; }

        // Ejes: los atributos que TODAS las variaciones con SKU tienen y que cambian entre ellas.
        const nombres = [...new Set(filas.flatMap((f) => Object.keys(f.valores)))];
        const candidatos = nombres.filter((n) => filas.every((f) => !!f.valores[n]) && new Set(filas.map((f) => normalizar(f.valores[n]))).size >= 2);
        if (!candidatos.length) { falla('las variaciones no traen atributos que las distingan (color, talla…)'); continue; }
        if (candidatos.length > MAX_EJES) { falla(`se distinguen por más de ${MAX_EJES} atributos (${candidatos.join(', ')})`); continue; }

        const axes: EjeDeVariacion[] = candidatos.map((nombre) => {
            const vistos = new Set<string>();
            const values: string[] = [];
            for (const f of filas) { const v = f.valores[nombre]; if (!vistos.has(normalizar(v))) { vistos.add(normalizar(v)); values.push(v); } }
            return { name: nombre, values };
        });
        const variants = filas.map((f) => ({
            sellerSku: f.sku,
            values: Object.fromEntries(axes.map((e) => [e.name, e.values.find((v) => normalizar(v) === normalizar(f.valores[e.name]))!])),
        }));
        if (new Set(variants.map((v) => claveDeCombinacion(v.values, axes))).size !== variants.length) { falla('dos variaciones quedarían con la misma combinación'); continue; }

        grupos.push({ parentSku, name: String(item.title ?? parentSku).slice(0, 250), axes, variants, origen: 'atributos' });
    }
    return { grupos, sinResolver };
}
