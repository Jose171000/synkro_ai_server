/**
 * Estado de una venta, igual para todos los canales. Cada canal usa sus propias palabras
 * (Falabella: pending, ready_to_ship, shipped, delivered, canceled, returned…; Mercado Libre: paid + el estado del envío),
 * así que se reducen a cinco para poder filtrar y contar sin saber de qué canal viene.
 */
export type EstadoDeVenta = 'pendiente' | 'enviado' | 'entregado' | 'cancelado' | 'devuelto';

export const ESTADOS_DE_VENTA: EstadoDeVenta[] = ['pendiente', 'enviado', 'entregado', 'cancelado', 'devuelto'];

/** Estados que NO cuentan como venta en los totales ni en el cobro a los clientes: la venta no se concretó o se devolvió. */
export const ESTADOS_QUE_NO_CUENTAN: EstadoDeVenta[] = ['cancelado', 'devuelto'];

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
 * Sin envío (retiro, acuerdo con el comprador) no hay quien diga que llegó: Mercado Libre la da por entregada pasados unos días
 * del pago, así que aquí también (antes quedaba «pendiente» para siempre). Si la venta trae la etiqueta `delivered`, también.
 */
export const DIAS_PARA_DAR_POR_ENTREGADA_SIN_ENVIO = 7;

export function estadoDeVentaMeli(orderStatus: string | null | undefined, shipmentStatus?: string | null, order?: any, ahora: number = Date.now()): EstadoDeVenta {
    if (/cancel/i.test(String(orderStatus ?? ''))) return 'cancelado';
    if (shipmentStatus) return estadoDeVenta(shipmentStatus);
    if (Array.isArray(order?.tags) && order.tags.includes('delivered')) return 'entregado';
    if (order && !order.shipping?.id) {
        const aprobado = (Array.isArray(order.payments) ? order.payments : [])
            .map((p: any) => new Date(p?.date_approved ?? '').getTime())
            .filter((t: number) => !Number.isNaN(t));
        const pago = aprobado.length ? Math.min(...aprobado) : new Date(order.date_closed ?? order.date_created ?? '').getTime();
        if (!Number.isNaN(pago) && ahora - pago >= DIAS_PARA_DAR_POR_ENTREGADA_SIN_ENVIO * 86_400_000) return 'entregado';
    }
    return 'pendiente';
}

/** Lee la lista de estados de un pedido de Falabella (`Statuses.Status`: texto o lista). */
export function estadosDePedidoFalabella(pedido: any): string {
    const e = pedido?.Statuses?.Status;
    return Array.isArray(e) ? e.join(', ') : String(e ?? '');
}
