/**
 * Una frase escrita para un canal («Garantía según las políticas de Mercado Libre») no es un dato del producto: copiada a la ficha de
 * otro canal sale mal. Estas funciones puras detectan los textos que nombran a un canal de venta.
 */

const CANALES: Record<string, RegExp> = {
    mercadolibre: /mercado\s*libre|mercadolibre|\bmeli\b/i,
    falabella: /falabella/i,
    ripley: /ripley/i,
    woocommerce: /woo\s*commerce|woocommerce/i,
    yavendio: /yavend[ií]o/i,
    amazon: /amazon/i,
    shopify: /shopify/i,
};

/** Canales que el texto nombra (claves internas: mercadolibre, falabella, ripley…). */
export function canalesNombrados(texto: unknown): string[] {
    const t = String(texto ?? '');
    if (!t.trim()) return [];
    return Object.entries(CANALES).filter(([, re]) => re.test(t)).map(([canal]) => canal);
}

/** ¿El texto nombra a un canal DISTINTO de `canal`? (Si no se indica canal, a cualquiera.) */
export function mencionaOtroCanal(texto: unknown, canal?: string): boolean {
    const propio = String(canal ?? '').toLowerCase().replace(/[^a-z]/g, '');
    return canalesNombrados(texto).some((c) => c !== propio);
}
