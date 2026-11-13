import { ajustarAUnaLista, normalizar } from '../ai/ripley-atributos';

/**
 * ¿Un producto con variantes (con los ejes que configuró la persona en Synkro) cabe en UNA sola publicación de un canal?
 * Depende de la categoría que tenga en ese canal: unas no admiten variantes y otras solo admiten ciertos ejes (color, talla…).
 * Cuando no cabe, las variantes se publican como productos SEPARADOS y se avisa a la persona. Vale para todos los canales:
 * cada uno aporta qué admite su categoría (`InfoVariantesDeCategoria`) y aquí se compara con los ejes de Synkro.
 * Funciones puras, sin red ni base de datos.
 */

export interface EjeSynkro { name: string; values: string[] }

/** Un dato de la categoría del canal que define la variante (Ripley: Color, Talla calzado; Falabella: ColorVariant…). */
export interface EjeDeCanal {
    id: string;
    label: string;
    /** Valores permitidos, si el canal los restringe (lista cerrada). */
    options?: string[];
    required?: boolean;
}

/** Cómo llega un valor de Synkro a la lista de un canal: igual, aproximado por la regla del canal, ajustado (IA / persona) o sin equivalente. */
export type EstadoDeValor = 'exacto' | 'aproximado' | 'ajustado' | 'sin';

/** Lo que se enviará al canal por cada valor de un eje, en UN dato del canal (un eje de color puede tener varios: «Color» y «Color básico»). */
export interface DetalleDeEje {
    eje: string;
    /** El dato del canal (etiqueta limpia). */
    atributo: string;
    atributoId: string;
    /** Dato de la misma clase que el principal (Color básico): su opción se deduce de la del principal, no se elige aparte. */
    derivado: boolean;
    opciones: string[];
    items: { valor: string; opcion: string | null; estado: EstadoDeValor }[];
}

export interface InfoVariantesDeCategoria {
    canal: string;
    categoryId: string | null;
    ruta?: string | null;
    /** La categoría admite agrupar variantes en una sola publicación. */
    admite: boolean;
    ejes: EjeDeCanal[];
    /** Otros datos con lista cerrada de la misma clase que un eje (Falabella: «Color básico» además de «Color»). Solo para mostrar qué saldrá. */
    extras?: EjeDeCanal[];
    /** El canal acepta cualquier eje (sin depender de la categoría), hasta este máximo. */
    libre?: boolean;
    maxEjes?: number;
    /** Ajustes que la persona ya confirmó para este canal: clase del dato (color, talla…) → valor normalizado → opción válida del canal. */
    ajustes?: Record<string, Record<string, string>>;
    /** La regla con la que el canal lleva un valor a su lista (por defecto la de Ripley). Debe ser la MISMA que usa al publicar. */
    automatico?: (valor: string, opciones: string[]) => string | null | undefined;
}

export type PublicaComo = 'una' | 'separadas';

export interface ResultadoDeCompatibilidad {
    canal: string;
    nombreDelCanal: string;
    categoryId: string | null;
    ruta: string | null;
    publicaComo: PublicaComo;
    /** Cada eje de Synkro con el dato del canal al que corresponde. */
    mapeo: { eje: string; atributo: string }[];
    ejesNoPermitidos: string[];
    /** Datos de variante del canal que ningún eje del producto está usando (con el nombre limpio, sin «variant»): a qué se podría renombrar un eje no aceptado. */
    ejesDisponibles: string[];
    /** Renombres que la IA recomienda (uno por eje no aceptado): la persona solo confirma. Nada se cambia solo. */
    renombresSugeridos?: { eje: string; a: string }[];
    ejesQueFaltan: string[];
    valoresSinEquivalente: { eje: string; valores: string[] }[];
    /** Qué saldrá en el canal por cada valor de cada eje (aunque todo esté bien): la pantalla lo muestra siempre. */
    detalle: DetalleDeEje[];
    /** Valores distintos que el canal llevaría a la MISMA opción («Celeste» y «Turquesa» → «Azul»): dos variantes quedarían con el mismo dato. */
    colisiones: { eje: string; atributo: string; opcion: string; valores: string[] }[];
    /** Frases para mostrar a la persona (en español). */
    avisos: string[];
    /**
     * Cuando las variantes irían separadas por la categoría: otra categoría, parecida y verificada para el producto, que SÍ admite
     * sus variantes. Es solo una recomendación: la que manda es la que mejor encaja con el producto y no se cambia sola.
     */
    recomendada?: { id: string; ruta: string } | null;
}

export const NOMBRE_DE_CANAL: Record<string, string> = {
    falabella: 'Falabella', ripley: 'Ripley', mercadolibre: 'Mercado Libre', shopify: 'Shopify', woocommerce: 'WooCommerce', amazon: 'Amazon',
};

/** «Color», «ColorVariant», «color_80», «Talla calzado» → la clase de dato: color, talla… (sinónimos entre canales). */
export function claseDeEje(texto: unknown): string {
    const n = normalizar(texto).replace(/\s+/g, '');
    if (!n) return '';
    if (/color|colour/.test(n)) return 'color';
    if (/talla|size|calzado|numero/.test(n)) return 'talla';
    if (/tamano|tamanio/.test(n)) return 'tamano';
    return n.replace(/variant$/, '').replace(/\d+$/, '');
}

/** Un eje con un solo valor (p. ej. «Modelo: CANGURO»): no distingue a las variantes entre sí, viaja como dato fijo del producto. */
const esEjeConstante = (e: EjeSynkro) => new Set((e.values ?? []).map((v) => String(v).trim().toLowerCase())).size <= 1;

const lista = (items: string[]) => items.map((i) => `«${i}»`).join(', ');

export function revisarCompatibilidad(ejes: EjeSynkro[], info: InfoVariantesDeCategoria): ResultadoDeCompatibilidad {
    const nombreDelCanal = NOMBRE_DE_CANAL[info.canal] ?? info.canal;
    const base: ResultadoDeCompatibilidad = {
        canal: info.canal, nombreDelCanal, categoryId: info.categoryId, ruta: info.ruta ?? null,
        publicaComo: 'una', mapeo: [], ejesNoPermitidos: [], ejesDisponibles: [], ejesQueFaltan: [], valoresSinEquivalente: [], detalle: [], colisiones: [], avisos: [],
    };
    const donde = info.ruta ? `La categoría «${info.ruta}» de ${nombreDelCanal}` : `La categoría elegida en ${nombreDelCanal}`;
    const separadas = (motivo: string): ResultadoDeCompatibilidad => ({
        ...base, publicaComo: 'separadas',
        avisos: [`${motivo} Las variantes se publicarán como productos separados en ${nombreDelCanal}, no en una sola publicación.`, ...base.avisos],
    });

    const ejesDelProducto = (ejes ?? []).filter((e) => e?.name);
    if (!ejesDelProducto.length) return base;

    // Canales sin categorías de variante: aceptan cualquier eje hasta su máximo.
    if (info.libre) {
        // Un eje con un solo valor no distingue a las variantes entre sí (es un dato fijo): no cuenta contra el máximo de ejes del canal.
        const quePesan = ejesDelProducto.filter((e) => !esEjeConstante(e));
        const ejesDeVariacion = quePesan.length ? quePesan : ejesDelProducto;
        if (info.maxEjes && ejesDeVariacion.length > info.maxEjes) {
            return separadas(`${nombreDelCanal} admite hasta ${info.maxEjes} ejes de variación y el producto tiene ${ejesDeVariacion.length}.`);
        }
        return { ...base, mapeo: ejesDeVariacion.map((e) => ({ eje: e.name, atributo: e.name })) };
    }

    if (!info.admite || !info.ejes.length) {
        return separadas(`${donde} no admite variantes.`);
    }

    // Cada eje de Synkro debe corresponder a un dato de variante de la categoría.
    const mapeo: { eje: string; atributo: string }[] = [];
    const usados = new Set<string>();
    const noPermitidos: string[] = [];
    for (const eje of ejesDelProducto) {
        const clase = claseDeEje(eje.name);
        const atributo = info.ejes.find((a) => !usados.has(a.id) && (claseDeEje(a.label) === clase || claseDeEje(a.id) === clase));
        if (atributo) { usados.add(atributo.id); mapeo.push({ eje: eje.name, atributo: atributo.id }); continue; }
        // Un eje con UN solo valor que la categoría no acepta (por ejemplo «Modelo: CANGURO») no distingue a las variantes entre sí: es un
        // dato fijo del producto y viaja como atributo normal. No debe impedir que las variantes que sí varían vayan en una sola publicación.
        if (esEjeConstante(eje) && ejesDelProducto.length > 1) continue;
        noPermitidos.push(eje.name);
    }
    // Datos de variante que la categoría exige y el producto no tiene como eje.
    const faltan = info.ejes.filter((a) => a.required && !usados.has(a.id)).map((a) => a.label);

    // Valores que no existen en la lista del canal (un color que Ripley no tiene) y valores distintos que caen en la misma opción.
    // Un valor que la persona ya ajustó a una opción válida cuenta como resuelto.
    const sinEquivalente: { eje: string; valores: string[] }[] = [];
    const colisiones: { eje: string; atributo: string; opcion: string; valores: string[] }[] = [];
    const automatico = info.automatico ?? ((v: string, o: string[]) => ajustarAUnaLista(v, o));
    const detalle: DetalleDeEje[] = [];
    for (const par of mapeo) {
        const atributo = info.ejes.find((a) => a.id === par.atributo);
        if (!atributo?.options?.length) continue;
        const valores = ejesDelProducto.find((e) => e.name === par.eje)?.values ?? [];
        const guardados = info.ajustes?.[claseDeEje(par.eje)] ?? {};
        // La misma regla que usa el canal al publicar (valorConAjuste): el ajuste de la persona si es válido en esta lista, el ajuste llevado
        // a la opción más cercana de esta lista, y si no, el valor tal cual o su opción más cercana.
        const resolver = (v: string, opciones: string[]): { opcion: string | null; estado: EstadoDeValor } => {
            const g = guardados[normalizar(v)];
            if (g) {
                const valida = opciones.find((o) => normalizar(o) === normalizar(g));
                if (valida) return { opcion: valida, estado: 'ajustado' };
                const desdeElAjuste = automatico(g, opciones);
                if (desdeElAjuste) return { opcion: desdeElAjuste, estado: 'ajustado' };
            }
            const exacta = opciones.find((o) => normalizar(o) === normalizar(v));
            if (exacta) return { opcion: exacta, estado: 'exacto' };
            const cercana = automatico(v, opciones);
            return cercana ? { opcion: cercana, estado: 'aproximado' } : { opcion: null, estado: 'sin' };
        };
        const opcionDe = (v: string): string | null => resolver(v, atributo.options!).opcion;
        const limpio = (e: EjeDeCanal) => String(e.label || e.id).replace(/s*variant$/i, '').trim();
        const unicos = [...new Set(valores.map((x) => String(x).trim()).filter(Boolean))];
        detalle.push({ eje: par.eje, atributo: limpio(atributo), atributoId: atributo.id, derivado: false, opciones: atributo.options, items: unicos.map((v) => ({ valor: v, ...resolver(v, atributo.options!) })) });
        for (const extra of (info.extras ?? []).filter((x) => x.id !== atributo.id && x.options?.length && claseDeEje(x.label || x.id) === claseDeEje(par.eje))) {
            detalle.push({ eje: par.eje, atributo: limpio(extra), atributoId: extra.id, derivado: true, opciones: extra.options!, items: unicos.map((v) => ({ valor: v, ...resolver(v, extra.options!) })) });
        }

        const malos = valores.filter((v) => opcionDe(v) === null);
        if (malos.length) sinEquivalente.push({ eje: par.eje, valores: malos });
        const porOpcion = new Map<string, string[]>();
        for (const v of unicos) {
            const o = opcionDe(v);
            if (o !== null) porOpcion.set(o, [...(porOpcion.get(o) ?? []), v]);
        }
        for (const [opcion, vs] of porOpcion) if (vs.length > 1) colisiones.push({ eje: par.eje, atributo: par.atributo, opcion, valores: vs });
    }

    // Solo se ofrece renombrar cuando hay un eje que el canal NO acepta tal como está; si todo encaja, no hay nada que cambiar.
    const disponibles = noPermitidos.length ? info.ejes.filter((a) => !usados.has(a.id)).map((a) => String(a.label).replace(/\s*variant$/i, '').trim()).filter(Boolean) : [];
    const resultado: ResultadoDeCompatibilidad = { ...base, mapeo, ejesNoPermitidos: noPermitidos, ejesDisponibles: disponibles, ejesQueFaltan: faltan, valoresSinEquivalente: sinEquivalente, detalle, colisiones };
    if (faltan.length) resultado.avisos.push(`${donde} también pide ${lista(faltan)} como dato de variante y el producto no tiene ese eje.`);
    for (const s of sinEquivalente) resultado.avisos.push(`En ${nombreDelCanal} no existen estos valores de «${s.eje}»: ${lista(s.valores)}. Se ajustarán al más cercano o habrá que cambiarlos.`);

    for (const c of colisiones) resultado.avisos.push(`En ${nombreDelCanal} estos valores de «${c.eje}» quedarían como «${c.opcion}»: ${lista(c.valores)}. Dos variantes no deberían llevar la misma opción.`);

    if (noPermitidos.length) {
        return {
            ...resultado, publicaComo: 'separadas',
            avisos: [`${donde} no acepta ${noPermitidos.length === 1 ? 'el eje' : 'los ejes'} ${lista(noPermitidos)} (acepta: ${lista(info.ejes.map((a) => a.label))}). Las variantes se publicarán como productos separados en ${nombreDelCanal}, no en una sola publicación.`, ...resultado.avisos],
        };
    }
    return resultado;
}
