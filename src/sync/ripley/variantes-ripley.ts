import { normalizar } from '../../products/variantes';
import { ChannelListingRow } from '../channels/channel-types';
import { GrupoSinResolver, PlanDeGrupo } from '../falabella/variantes-falabella';

/**
 * Variantes de Ripley (Mirakl).
 *
 * Cada oferta trae el código de su producto en el catálogo de Ripley con la forma «PMP20001695273-5»: la base
 * («PMP20001695273») es la familia y el sufijo («-5») la variante. Verificado con la cuenta real de Chumpi Bags: las 266 ofertas
 * traen ese código y se agrupan en 69 familias (48 con varias ofertas), todas de la misma categoría. Esa es la agrupación.
 *
 * Lo que las ofertas NO dicen es en qué se diferencian (el color): se deduce de las palabras del título que cambian de una
 * oferta a otra («LONCHERA ROSADA…» / «LONCHERA NEGRO…»). Si los títulos son iguales o no dejan un valor claro y distinto en cada
 * oferta, la familia queda sin resolver para estructurarla a mano. Nunca se adivina.
 */

/** Separa «PMP20001695273-5» en su familia y su variante; null si no tiene ese formato. */
export function familiaDeProducto(codigo: unknown): { base: string; variante: string } | null {
    const m = /^(.+)-(\d+)$/.exec(String(codigo ?? '').trim());
    return m ? { base: m[1], variante: m[2] } : null;
}

const palabrasDe = (titulo: string) => titulo.split(/\s+/).map((p) => p.replace(/^[\s\-–,:|/()]+|[\s\-–,:|/()]+$/g, '')).filter(Boolean);
const bonito = (texto: string) => {
    const t = texto.toLowerCase();
    return t.charAt(0).toUpperCase() + t.slice(1);
};
const MAX_PALABRAS_DE_VALOR = 3;
const MOTIVO_SIN_VALORES = 'Ripley no dice en qué se diferencian estas ofertas (los títulos son iguales o no distinguen el color). Indícalo a mano.';

/** Las palabras que cambian de una oferta a otra, por oferta; null si no dejan un valor claro y distinto en cada una. */
function valoresPorTitulo(filas: ChannelListingRow[]): Map<string, string> | null {
    const listas = filas.map((f) => palabrasDe(f.title));
    const comunes = listas.map((l) => new Set(l.map(normalizar))).reduce((a, b) => new Set([...a].filter((x) => b.has(x))));
    const valores = new Map<string, string>();
    const vistos = new Set<string>();
    for (let i = 0; i < filas.length; i++) {
        const propias = listas[i].filter((p) => !comunes.has(normalizar(p)));
        if (!propias.length || propias.length > MAX_PALABRAS_DE_VALOR) return null;
        const valor = bonito(propias.join(' ')).slice(0, 60);
        if (vistos.has(normalizar(valor))) return null;
        vistos.add(normalizar(valor));
        valores.set(filas[i].sku, valor);
    }
    return valores;
}

/** Nombre de la familia: el título sin las palabras que cambian. */
function nombreDeFamilia(filas: ChannelListingRow[], parentSku: string): string {
    const listas = filas.map((f) => palabrasDe(f.title));
    const comunes = listas.map((l) => new Set(l.map(normalizar))).reduce((a, b) => new Set([...a].filter((x) => b.has(x))));
    const nombre = listas[0].filter((p) => comunes.has(normalizar(p))).join(' ').replace(/[\s\-–,:|/]+$/g, '').trim();
    return (nombre.length >= 3 ? nombre : filas[0].title || parentSku).slice(0, 250);
}

export function planearGruposDeRipley(filas: ChannelListingRow[]): { grupos: PlanDeGrupo[]; sinResolver: GrupoSinResolver[] } {
    const porFamilia = new Map<string, ChannelListingRow[]>();
    const skusVistos = new Set<string>();
    for (const f of filas) {
        if (!f.groupKey || skusVistos.has(f.sku)) continue;
        skusVistos.add(f.sku);
        const lista = porFamilia.get(f.groupKey) ?? [];
        lista.push(f);
        porFamilia.set(f.groupKey, lista);
    }

    const grupos: PlanDeGrupo[] = [];
    const sinResolver: GrupoSinResolver[] = [];
    for (const [parentSku, miembros] of porFamilia) {
        if (miembros.length < 2) continue; // una sola oferta: producto suelto
        const valores = valoresPorTitulo(miembros);
        if (!valores) {
            sinResolver.push({
                parentSku,
                skus: miembros.map((m) => m.sku),
                motivo: MOTIVO_SIN_VALORES,
                titulo: miembros[0].title,
                fichas: miembros.map((m) => ({ sku: m.sku, nombre: m.title, imagen: m.imageUrl })),
            });
            continue;
        }
        grupos.push({
            parentSku,
            name: nombreDeFamilia(miembros, parentSku),
            axes: [{ name: 'Color', values: miembros.map((m) => valores.get(m.sku)!) }],
            variants: miembros.map((m) => ({ sellerSku: m.sku, values: { Color: valores.get(m.sku)! } })),
            origen: 'titulo',
        });
    }
    return { grupos, sinResolver };
}
