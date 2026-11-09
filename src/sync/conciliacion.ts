import { createHash } from 'crypto';

/**
 * Conciliación: avisar cuando un canal tiene un stock (o, en Ripley, un precio) distinto al de Synkro. Parte pura (sin red ni base de
 * datos). No corrige nada: el aviso lleva al Tablero, donde «Reenviar» sigue pasando por la aprobación de la tienda.
 *
 * Para no dar falsas alarmas, una diferencia solo se avisa si se ve en dos revisiones seguidas (un cambio recién enviado o una venta
 * recién registrada tardan en llegar al canal), y el mismo aviso no se repite hasta que cambie la lista o pasen 24 horas.
 */

export type CampoDeDiferencia = 'stock' | 'price';

/** Una publicación activa con lo que Synkro tiene y lo que el canal mostró en la última revisión. */
export interface EnlaceParaConciliar {
    linkId: string;
    productId: string;
    sku: string;
    nombre: string;
    marketplace: string;
    connectionId: string;
    cuenta: string | null;
    stockSynkro: number | null;
    stockCanal: number | null;
    precioSynkro: number | null;
    precioCanal: number | null;
    /** Rebaja que el canal muestra (Ripley no las toca Synkro). */
    rebajaCanal: number | null;
    /** Precio fijado a mano para esa cuenta. */
    precioPropio: number | null;
}

export interface Diferencia {
    /** Identifica la diferencia con sus valores: si el valor cambia, es otra diferencia. */
    clave: string;
    linkId: string;
    productId: string;
    sku: string;
    nombre: string;
    marketplace: string;
    cuenta: string | null;
    campo: CampoDeDiferencia;
    canal: number;
    synkro: number;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const centavos = (n: number) => Math.round(n * 100);

/**
 * Las diferencias de una publicación. El stock se compara en todos los canales; el precio solo en Ripley, en ofertas sin rebaja y sin
 * precio propio (y solo si el envío de precios está habilitado: si no, no hay cómo corregirlo desde Synkro).
 */
export function diferenciasDe(e: EnlaceParaConciliar, opciones: { precioRipley: boolean }): Diferencia[] {
    const salida: Diferencia[] = [];
    const base = { linkId: e.linkId, productId: e.productId, sku: e.sku, nombre: e.nombre, marketplace: e.marketplace, cuenta: e.cuenta };

    const stockSynkro = num(e.stockSynkro);
    const stockCanal = num(e.stockCanal);
    if (stockSynkro !== null && stockCanal !== null && stockSynkro !== stockCanal) {
        salida.push({ ...base, campo: 'stock', canal: stockCanal, synkro: stockSynkro, clave: `${e.linkId}|stock|${stockCanal}|${stockSynkro}` });
    }

    if (e.marketplace === 'ripley' && opciones.precioRipley && num(e.rebajaCanal) === null && num(e.precioPropio) === null) {
        const precioSynkro = num(e.precioSynkro);
        const precioCanal = num(e.precioCanal);
        if (precioSynkro !== null && precioSynkro > 0 && precioCanal !== null && centavos(precioSynkro) !== centavos(precioCanal)) {
            salida.push({ ...base, campo: 'price', canal: precioCanal, synkro: precioSynkro, clave: `${e.linkId}|price|${precioCanal}|${precioSynkro}` });
        }
    }
    return salida;
}

/**
 * Cuenta cuántas revisiones seguidas lleva cada diferencia. `previo` es lo que se guardó la vez anterior (clave → veces). Una
 * diferencia que ya no está sale del registro; una cuyo valor cambió empieza de nuevo. Persistentes: las vistas dos veces o más.
 */
export function contarPasadas(previo: Record<string, number> | null | undefined, actuales: Diferencia[]): { estado: Record<string, number>; persistentes: Diferencia[] } {
    const estado: Record<string, number> = {};
    const persistentes: Diferencia[] = [];
    for (const d of actuales) {
        const veces = (previo?.[d.clave] ?? 0) + 1;
        estado[d.clave] = veces;
        if (veces >= 2) persistentes.push(d);
    }
    return { estado, persistentes };
}

export const firmaDe = (difs: Diferencia[]): string =>
    difs.length ? createHash('sha1').update(difs.map((d) => d.clave).sort().join('\n')).digest('hex').slice(0, 16) : '';

/** Se avisa si hay diferencias persistentes y la lista cambió desde el último aviso, o pasaron `horas` desde que se avisó. */
export function debeAvisar(args: { firma: string; firmaAvisada?: string | null; avisadoEn?: number | null; ahora: number; horas?: number }): boolean {
    if (!args.firma) return false;
    if (args.firma !== (args.firmaAvisada ?? '')) return true;
    return args.ahora - (args.avisadoEn ?? 0) >= (args.horas ?? 24) * 3600_000;
}

const ETIQUETA: Record<CampoDeDiferencia, string> = { stock: 'stock', price: 'precio' };
const MAX_EN_TEXTO = 5;
const MAX_EN_DATOS = 20;

/** Más grave primero: un canal con más stock del que hay (se puede vender lo que no se tiene) o con un precio más bajo. */
const esRiesgo = (d: Diferencia) => (d.campo === 'stock' ? d.canal > d.synkro : d.canal < d.synkro);

export function resumenDeAviso(difs: Diferencia[], nombreCanal: (id: string) => string) {
    const ordenadas = [...difs].sort((a, b) => Number(esRiesgo(b)) - Number(esRiesgo(a)) || a.sku.localeCompare(b.sku));
    const nStock = difs.filter((d) => d.campo === 'stock').length;
    const nPrecio = difs.filter((d) => d.campo === 'price').length;
    const partes = [
        nStock ? `${nStock} con stock distinto` : '',
        nPrecio ? `${nPrecio} con precio distinto` : '',
    ].filter(Boolean);
    const canales = [...new Set(difs.map((d) => nombreCanal(d.marketplace)))];
    const title = `Diferencias con Synkro: ${partes.join(' y ')}`;
    const lineas = ordenadas.slice(0, MAX_EN_TEXTO).map(
        (d) => `${d.sku} (${nombreCanal(d.marketplace)}${d.cuenta ? ` · ${d.cuenta}` : ''}): ${ETIQUETA[d.campo]} ${d.canal} en el canal, ${d.synkro} en Synkro`,
    );
    const resto = difs.length - lineas.length;
    const body = [
        `${canales.join(', ')}. ${lineas.join('. ')}.`,
        resto > 0 ? ` … y ${resto} más.` : '',
        ' Revisa el Tablero y usa «Reenviar» para corregirlas.',
    ].join('');
    return {
        title,
        body,
        severity: difs.some(esRiesgo) ? ('warning' as const) : ('info' as const),
        items: ordenadas.slice(0, MAX_EN_DATOS).map(({ productId, sku, marketplace, cuenta, campo, canal, synkro }) => ({ productId, sku, marketplace, cuenta, campo, canal, synkro })),
    };
}
