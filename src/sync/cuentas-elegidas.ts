/**
 * Qué cuentas de cada canal recibe un producto. Una tienda puede tener hasta 3 cuentas por canal: la persona elige en cuál
 * publicar. Sin elección (flujos antiguos) se usan todas las cuentas activas, como antes.
 */
export type CuentasElegidas = Record<string, string[]>;

/** De las cuentas activas del canal, las que la persona eligió (o todas si no eligió ninguna). */
export function cuentasParaPublicar(activas: string[], elegidas?: string[] | null): string[] {
    if (!elegidas || !elegidas.length) return activas;
    const pedidas = new Set(elegidas);
    return activas.filter((id) => pedidas.has(id));
}

/** Lee la elección que llega de un formulario o de una petición: {canal: [ids]}; ignora todo lo que no tenga esa forma. */
export function leerCuentasElegidas(crudo: unknown): CuentasElegidas {
    let origen: any = crudo;
    if (typeof crudo === 'string') {
        try { origen = JSON.parse(crudo); } catch { return {}; }
    }
    if (!origen || typeof origen !== 'object' || Array.isArray(origen)) return {};
    const salida: CuentasElegidas = {};
    for (const [canal, ids] of Object.entries(origen)) {
        const lista = (Array.isArray(ids) ? ids : typeof ids === 'string' ? [ids] : [])
            .filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x));
        if (lista.length) salida[String(canal).toLowerCase()] = [...new Set(lista)];
    }
    return salida;
}
