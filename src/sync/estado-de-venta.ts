/**
 * Estado de una venta, igual para todos los canales. Cada canal usa sus propias palabras
 * (Falabella: pending, ready_to_ship, shipped, delivered, canceled, returned…; Mercado Libre: paid + el estado del envío),
 * así que se reducen a cinco para poder filtrar y contar sin saber de qué canal viene.
 */
export type EstadoDeVenta = 'pendiente' | 'enviado' | 'entregado' | 'cancelado' | 'devuelto';

export const ESTADOS_DE_VENTA: EstadoDeVenta[] = ['pendiente', 'enviado', 'entregado', 'cancelado', 'devuelto'];

/** Estados de los que una venta ya no suele salir: no vale la pena volver a consultarla al canal. */
export const ESTADOS_FINALES: EstadoDeVenta[] = ['entregado', 'cancelado', 'devuelto'];

function palabras(...textos: (string | null | undefined)[]): string[] {
    return textos
        .flatMap((t) => String(t ?? '').toLowerCase().split(/[,;|()]+/))
        .map((t) => t.trim())
        .filter(Boolean);
}

/** Un solo estado de un canal (un artículo de Falabella, o el envío de Mercado Libre). */
function deUnaPalabra(p: string): EstadoDeVenta {
    if (/return|devuel|refund|reembols|not_delivered|failed_delivery|undeliver/.test(p)) return 'devuelto';
    if (/cancel|fail|rechaz/.test(p)) return 'cancelado';
    if (/ready_to_ship|ready to ship/.test(p)) return 'pendiente';
    if (/deliver|entreg|complet|closed/.test(p)) return 'entregado';
    if (/ship|enviad|transit|dispatch|picked/.test(p)) return 'enviado';
    return 'pendiente';
}

/** Cuánto ha avanzado cada estado: una venta con artículos en estados distintos cuenta como la parte menos avanzada. */
const AVANCE: Record<EstadoDeVenta, number> = { pendiente: 0, enviado: 1, entregado: 2, cancelado: -1, devuelto: -1 };

/**
 * Resume en un estado lo que dice el canal. Acepta varias palabras (Falabella manda una por artículo: «pending, shipped»).
 * Si todo está cancelado, la venta está cancelada; si solo una parte, cuenta el resto. Lo mismo con devuelto.
 */
export function estadoDeVenta(...textos: (string | null | undefined)[]): EstadoDeVenta {
    const lista = palabras(...textos).map(deUnaPalabra);
    if (!lista.length) return 'pendiente';
    const vivos = lista.filter((e) => AVANCE[e] >= 0);
    if (!vivos.length) return lista.includes('devuelto') ? 'devuelto' : 'cancelado';
    return vivos.reduce((menor, e) => (AVANCE[e] < AVANCE[menor] ? e : menor));
}

/**
 * Mercado Libre: la venta dice si se pagó o se canceló; si salió y llegó lo dice el envío.
 * Sin envío (retiro, acuerdo con el comprador) una venta pagada queda como pendiente hasta que el canal diga otra cosa.
 */
export function estadoDeVentaMeli(orderStatus: string | null | undefined, shipmentStatus?: string | null): EstadoDeVenta {
    if (/cancel/i.test(String(orderStatus ?? ''))) return 'cancelado';
    return shipmentStatus ? estadoDeVenta(shipmentStatus) : 'pendiente';
}

/** Lee la lista de estados de un pedido de Falabella (`Statuses.Status`: texto o lista). */
export function estadosDePedidoFalabella(pedido: any): string {
    const e = pedido?.Statuses?.Status;
    return Array.isArray(e) ? e.join(', ') : String(e ?? '');
}
