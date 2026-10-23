import { EjeDeVariacion } from '../../products/entities/product-group.entity';
import { MAX_EJES, claveDeCombinacion, normalizar } from '../../products/variantes';
import { PlanDeGrupo } from './variantes-falabella';

/**
 * Segundo recurso cuando la página pública de Falabella no sirve: una IA lee los títulos, atributos y SKU de las fichas
 * de una familia y propone el eje de variación y el valor de cada SKU. Una IA puede equivocarse, así que su propuesta se
 * VERIFICA aquí antes de usarla: cada valor tiene que aparecer escrito en los datos de su propia ficha. Lo que no se
 * pueda comprobar no se aplica y pasa a la revisión manual, con la propuesta como sugerencia.
 */

export interface FichaParaIA {
    sellerSku: string;
    nombre: string;
    variation: string | null;
    atributos: Record<string, string>;
}

export interface PropuestaDeEjes {
    ejes: { nombre: string; evidencia?: string }[];
    /** Por SKU: el valor de cada eje. */
    valores: Record<string, Record<string, string>>;
    confianza: 'alta' | 'media' | 'baja';
    motivo?: string;
}

/** Hook que registra el módulo de IA; sin él (o si falla) la familia pasa a la revisión manual. */
export type ProponerEjesConIA = (fichas: FichaParaIA[]) => Promise<PropuestaDeEjes | null>;

const limpio = (t: unknown) => (typeof t === 'string' || typeof t === 'number' ? String(t).trim().replace(/\s+/g, ' ').slice(0, 60) : '');
const sinSeparadores = (t: string) => normalizar(t).replace(/[^a-z0-9]/g, '');

/** Palabras de color (y sus modificadores) que se aceptan cuando el valor solo se apoya en el código del SKU. */
const PALABRAS_DE_COLOR = new Set((
    'blanco negro gris plomo plateado plata dorado oro beige crema marfil hueso arena cafe marron chocolate camel nude rojo vino burdeos guinda granate ' +
    'rosa rosado fucsia palo pastel lila morado violeta uva lavanda purpura azul celeste turquesa acero marino petroleo aqua verde oliva menta musgo ' +
    'amarillo mostaza naranja anaranjado coral cemento humo ceniza topo taupe claro oscuro suave intenso multicolor transparente natural cobre bronce'
).split(' '));

/** «Beige claro» y «Azul acero» son colores; «PP» o «TU» son códigos que no se pueden traducir con certeza. */
function esValorDeColor(valor: string): boolean {
    const palabras = normalizar(valor).split(/[^a-z0-9]+/).filter(Boolean);
    return palabras.length > 0 && palabras.every((p) => PALABRAS_DE_COLOR.has(p));
}

/** El valor está escrito en los datos de la ficha (título, variación, atributos o SKU). */
export function respaldado(valor: string, ficha: FichaParaIA): boolean {
    const v = sinSeparadores(valor);
    if (!v) return false;
    const textos = [ficha.nombre, ficha.variation ?? '', ...Object.values(ficha.atributos ?? {})].map(String);
    // Un valor de una sola letra (talla S, M, L) solo vale como palabra completa: «s» está dentro de casi cualquier texto.
    const enTextos = v.length < 2 ? textos.some((t) => normalizar(t).split(/[^a-z0-9]+/).includes(v)) : textos.some((t) => sinSeparadores(t).includes(v));
    if (enTextos) return true;
    // Solo está en el código del SKU: vale únicamente si es un color reconocible («…-BEIGE»); un código como «PP» no se traduce.
    return v.length >= 2 && sinSeparadores(ficha.sellerSku).includes(v) && esValorDeColor(valor);
}

export interface ResultadoDeValidacion {
    plan: Omit<PlanDeGrupo, 'name' | 'parentSku'> | null;
    motivo?: string;
}

export function validarPropuestaDeIA(fichas: FichaParaIA[], propuesta: PropuestaDeEjes | null): ResultadoDeValidacion {
    if (!propuesta) return { plan: null, motivo: 'la IA no devolvió una propuesta' };
    if (propuesta.confianza === 'baja') return { plan: null, motivo: propuesta.motivo || 'la IA no está segura de los ejes' };

    const nombres = (propuesta.ejes ?? []).map((e) => limpio(e?.nombre)).filter(Boolean);
    if (!nombres.length || nombres.length > MAX_EJES || new Set(nombres.map(normalizar)).size !== nombres.length) return { plan: null, motivo: 'los ejes propuestos no son válidos' };

    const skus = fichas.map((f) => f.sellerSku);
    const porSku = new Map(skus.map((s, i) => [s, fichas[i]]));
    const variants: PlanDeGrupo['variants'] = [];
    for (const sku of skus) {
        const crudos = propuesta.valores?.[sku];
        if (!crudos || typeof crudos !== 'object') return { plan: null, motivo: `la IA no dio valores para ${sku}` };
        const values: Record<string, string> = {};
        for (const eje of nombres) {
            const v = limpio((crudos as any)[eje]);
            if (!v) return { plan: null, motivo: `falta el valor de «${eje}» para ${sku}` };
            if (!respaldado(v, porSku.get(sku)!)) return { plan: null, motivo: `«${v}» no aparece escrito en los datos de ${sku}: no se puede comprobar` };
            values[eje] = v;
        }
        variants.push({ sellerSku: sku, values });
    }

    const axes: EjeDeVariacion[] = nombres.map((nombre) => {
        const vistos = new Set<string>();
        const values: string[] = [];
        for (const v of variants) { const x = v.values[nombre]; if (!vistos.has(normalizar(x))) { vistos.add(normalizar(x)); values.push(x); } }
        return { name: nombre, values };
    });
    if (axes.some((e) => e.values.length < 2)) return { plan: null, motivo: 'un eje propuesto no distingue las variantes (todas tienen el mismo valor)' };
    // La escritura oficial de cada valor es la primera que apareció en el eje.
    for (const v of variants) for (const e of axes) v.values[e.name] = e.values.find((x) => normalizar(x) === normalizar(v.values[e.name]))!;
    if (new Set(variants.map((v) => claveDeCombinacion(v.values, axes))).size !== variants.length) return { plan: null, motivo: 'dos variantes quedarían con la misma combinación' };

    return { plan: { axes, variants, origen: 'ia' } };
}
