import { MeliListingRow } from './meli-listings';

/**
 * Publicaciones duplicadas: dos o más publicaciones de una misma cuenta de Mercado Libre con el mismo SKU. No son variantes
 * (un SKU es un producto); un producto de Synkro solo puede enlazarse con una publicación por cuenta. Se elige una como
 * principal y las demás se informan para que la persona decida (pausarlas o cerrarlas en Mercado Libre).
 */

export interface PublicacionDuplicada {
    externalId: string;
    variationId: string | null;
    titulo: string;
    estado: string;
    precio: number | null;
    stock: number;
    vendidas: number;
    permalink: string | null;
    imagen: string | null;
    /** Tipo de publicación y, si Mercado Libre la marca como sincronizada, con cuál. */
    tipo: string | null;
    sincronizadaCon: string | null;
    /** La que se enlaza con el producto de Synkro. */
    principal: boolean;
}

export interface DuplicadoMeli {
    sku: string;
    publicaciones: PublicacionDuplicada[];
}

/** Identifica una fila (publicación o variación) dentro de su cuenta. */
export const claveDeFilaMeli = (f: Pick<MeliListingRow, 'externalId' | 'variationId'>): string => `${f.externalId}:${f.variationId ?? ''}`;

const normalizarSku = (sku: string) => sku.trim().toLowerCase();

/**
 * La principal es la que está activa; entre varias activas, la que más vendió; luego la de más stock; luego la primera que
 * llegó. Así se conserva la que ya trae las ventas y se informa el resto.
 */
export function detectarDuplicados(filas: MeliListingRow[]): { duplicados: DuplicadoMeli[]; secundarias: Set<string> } {
    const porSku = new Map<string, MeliListingRow[]>();
    for (const f of filas) {
        if (!f.sku) continue;
        const k = normalizarSku(f.sku);
        porSku.set(k, [...(porSku.get(k) ?? []), f]);
    }

    const duplicados: DuplicadoMeli[] = [];
    const secundarias = new Set<string>();
    for (const grupo of porSku.values()) {
        if (grupo.length < 2) continue;
        const orden = [...grupo].sort((a, b) =>
            Number(b.status === 'published') - Number(a.status === 'published') ||
            (b.vendidas ?? 0) - (a.vendidas ?? 0) ||
            b.stock - a.stock);
        const principal = orden[0];
        for (const f of orden.slice(1)) secundarias.add(claveDeFilaMeli(f));
        duplicados.push({
            sku: principal.sku,
            publicaciones: orden.map((f) => ({
                externalId: f.externalId,
                variationId: f.variationId,
                titulo: f.title.slice(0, 120),
                estado: f.status,
                precio: f.regularPrice,
                stock: f.stock,
                vendidas: f.vendidas ?? 0,
                permalink: f.permalink,
                imagen: f.imageUrl,
                tipo: f.tipo ?? null,
                sincronizadaCon: f.sincronizadaCon ?? null,
                principal: f === principal,
            })),
        });
    }
    return { duplicados, secundarias };
}

/**
 * De las publicaciones que la persona pidió pausar o cerrar, cuáles se pueden tocar sin riesgo. Se decide con los datos de
 * Mercado Libre de este momento, nunca con lo que mande el navegador: solo vale una publicación repetida que NO es la
 * principal de ningún SKU y cuyas filas (todas sus variaciones) son repetidas; si no, se rechaza y se dice por qué.
 */
export function elegirDuplicadasAfectables(
    filas: MeliListingRow[],
    secundarias: Set<string>,
    solicitadas: string[],
): { aplicables: string[]; rechazadas: { externalId: string; motivo: string }[] } {
    const aplicables: string[] = [];
    const rechazadas: { externalId: string; motivo: string }[] = [];
    for (const externalId of [...new Set(solicitadas)]) {
        const propias = filas.filter((f) => f.externalId === externalId);
        if (!propias.length) { rechazadas.push({ externalId, motivo: 'no se encontró entre las publicaciones de la cuenta' }); continue; }
        if (propias.some((f) => !secundarias.has(claveDeFilaMeli(f)))) {
            rechazadas.push({ externalId, motivo: 'es la principal de un SKU o tiene variaciones que no son repetidas: no se toca' });
            continue;
        }
        if (propias.every((f) => f.status === 'error')) { rechazadas.push({ externalId, motivo: 'Mercado Libre la tiene bloqueada o en revisión' }); continue; }
        aplicables.push(externalId);
    }
    return { aplicables, rechazadas };
}
