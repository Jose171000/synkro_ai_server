/**
 * ¿Esta venta ocurrió ANTES de conectar la cuenta a Synkro?
 *
 * Al conectar una cuenta, la primera consulta lee los pedidos de los últimos días y todos le parecen «nuevos» solo porque Synkro
 * aún no los tenía. Pero esas ventas ya pasaron: el stock que Synkro trajo del canal ya las refleja, y avisar de ellas (correo,
 * aviso en la campana) o descontarlas otra vez sería contar dos veces. Una venta así se guarda como constancia, igual que el
 * historial, sin tocar el stock ni avisar a nadie.
 *
 * Sin fecha de la venta o de la conexión no se puede saber, y se trata como venta nueva (lo de siempre).
 */
export function ventaAnteriorALaConexion(
    conexion: { createdAt?: Date | string | null } | null | undefined,
    fechaDeLaVenta: Date | string | null | undefined,
): boolean {
    if (!conexion?.createdAt || !fechaDeLaVenta) return false;
    const conectada = new Date(conexion.createdAt).getTime();
    const vendida = new Date(fechaDeLaVenta).getTime();
    if (Number.isNaN(conectada) || Number.isNaN(vendida)) return false;
    return vendida < conectada;
}
