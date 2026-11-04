import { EstadoDeVenta } from './estado-de-venta';
import { OrderLine } from './order-details';

/**
 * Qué pasa con el stock cuando una venta que ya lo había descontado se cancela o se devuelve.
 *
 *  - Si la venta NO había salido (estaba «pendiente»), el producto nunca dejó el almacén: el stock se repone al instante.
 *  - Si YA había salido (enviada o entregada), el producto tarda en volver: no se repone solo. Queda «por reponer» y una
 *    persona lo confirma cuando el producto llega, para no ofrecer en los canales unidades que todavía no se tienen.
 *
 * Solo cuentan las líneas a las que esa venta les descontó stock (llevan «stock antes») y que no se repusieron ya.
 */
export type AccionDeReposicion = 'ninguna' | 'reponer' | 'por_reponer';

const SE_DEVUELVE: EstadoDeVenta[] = ['cancelado', 'devuelto'];
const YA_SALIO: EstadoDeVenta[] = ['enviado', 'entregado'];

/** ¿Esta línea descontó stock y aún no se resolvió (ni repuesta ni a la espera)? */
export function lineaPendienteDeResolver(l: OrderLine | null | undefined): boolean {
    return !!l?.productId && l.stockBefore != null && !l.repuesto && !l.porReponer;
}

/** ¿Esta línea quedó esperando que el producto vuelva al almacén? */
export function lineaPorReponer(l: OrderLine | null | undefined): boolean {
    return !!l?.productId && !!l.porReponer && !l.repuesto;
}

export function accionDeReposicion(antes: EstadoDeVenta | null | undefined, ahora: EstadoDeVenta | null | undefined): AccionDeReposicion {
    if (!ahora || !SE_DEVUELVE.includes(ahora)) return 'ninguna';
    // Ya estaba cancelada o devuelta: el cambio ya se trató la primera vez.
    if (!antes || SE_DEVUELVE.includes(antes)) return 'ninguna';
    return YA_SALIO.includes(antes) ? 'por_reponer' : 'reponer';
}
