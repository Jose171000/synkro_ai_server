/**
 * Moneda de cada cuenta.
 *
 * Hasta ahora el código daba por hecho que todas las ventas eran en soles:
 * había un `currency: 'PEN'` escrito a mano en la importación de pedidos de
 * Falabella. Con un cliente peruano no se nota, pero con uno colombiano las
 * ventas se guardarían como soles y la facturación saldría mal sin dar ningún
 * error — que es la peor forma de fallar.
 *
 * La moneda se decide en este orden:
 *   1. La que diga el propio marketplace en el pedido (la más fiable).
 *   2. La que se guardó en la conexión al conectar esa cuenta.
 *   3. La de por defecto de la instalación (`DEFAULT_CURRENCY`).
 */

/** Códigos ISO 4217 admitidos, por país ISO 3166-1 alfa-2. */
export const MONEDA_POR_PAIS: Record<string, string> = {
    PE: 'PEN',
    CO: 'COP',
    CL: 'CLP',
    MX: 'MXN',
    AR: 'ARS',
    BR: 'BRL',
    UY: 'UYU',
    EC: 'USD',
    US: 'USD',
};

/** Países donde opera Falabella Seller Center. */
export const PAISES_FALABELLA = ['PE', 'CL', 'CO'] as const;
export type PaisFalabella = typeof PAISES_FALABELLA[number];

/**
 * Moneda por defecto de esta instalación. Configurable para que un despliegue
 * en otro país no dependa de tocar el código.
 */
export function monedaPorDefecto(): string {
    return normalizarMoneda(process.env.DEFAULT_CURRENCY) ?? 'PEN';
}

/**
 * Deja un código de moneda en su forma canónica, o devuelve `undefined` si no
 * lo parece. Sirve de filtro: si un marketplace manda basura en ese campo,
 * preferimos caer al siguiente escalón antes que guardar un valor inventado.
 */
export function normalizarMoneda(valor: unknown): string | undefined {
    if (typeof valor !== 'string') return undefined;
    const limpio = valor.trim().toUpperCase();
    return /^[A-Z]{3}$/.test(limpio) ? limpio : undefined;
}

/** Moneda de un país, si la conocemos. */
export function monedaDePais(pais: unknown): string | undefined {
    if (typeof pais !== 'string') return undefined;
    return MONEDA_POR_PAIS[pais.trim().toUpperCase()];
}

/**
 * Aplica el orden de preferencia y devuelve siempre algo utilizable.
 * Los candidatos se leen de izquierda a derecha; el primero válido gana.
 */
export function resolverMoneda(...candidatos: unknown[]): string {
    for (const candidato of candidatos) {
        const moneda = normalizarMoneda(candidato);
        if (moneda) return moneda;
    }
    return monedaPorDefecto();
}
