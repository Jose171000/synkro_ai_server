/**
 * Lo que el producto YA sabe de sí mismo (material, capacidad, medidas, marca… que vienen de otro canal o de lo que alguien revisó)
 * se le pasa a la IA como dato de partida para un canal nuevo. Sin esto, cada canal «redescubre» el producto solo con el nombre y
 * las fotos y contradice lo que ya está confirmado.
 */

/** Atributos que no describen el producto: técnicos, de otros canales o ya cubiertos por la plataforma. */
const IGNORAR = new Set([
    'descriptionhtml', 'vision', 'estimated', 'brand', 'conditiontypenote', 'conditiontype', 'namecn', 'nameen', 'packagecontent',
    'sellerwarranty', 'productwarranty', 'productionyear', 'productionmonth', 'tipodeobjetoparatransporte', 'importado',
    'sizechartname', 'parentsku', 'sellersku', 'color', 'colorbasico', 'talla', 'size', 'color_basico', 'maincolor',
]);

const claveSimple = (k: string) => k.toLowerCase().replace(/[^a-z0-9_]/g, '');

/** Los datos simples del producto, listos para pasarlos a la IA ({etiqueta: valor}); vacío si no hay ninguno útil. */
export function datosConocidos(atributos: Record<string, any> | null | undefined, extra: Record<string, number | string | null | undefined> = {}): Record<string, string> {
    const salida: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...(atributos ?? {}), ...extra })) {
        if (k.startsWith('_') || /(_attributes|_ia)$/.test(k) || /^(ripley|mercadolibre|falabella|amazon|shopify)/i.test(k)) continue;
        if (IGNORAR.has(claveSimple(k))) continue;
        if (v === null || v === undefined || typeof v === 'object') continue;
        const texto = String(v).trim();
        if (!texto || texto.length > 80 || /^(null|n\/a|desconocido|no especificado|undefined)$/i.test(texto)) continue;
        salida[k] = texto;
    }
    return salida;
}

/** El párrafo que se añade a la descripción que ve la IA. Vacío si no hay datos. */
export function textoDeDatosConocidos(datos: Record<string, string> | null | undefined): string {
    const filas = Object.entries(datos ?? {});
    if (!filas.length) return '';
    return [
        'Datos ya confirmados de este producto (úsalos tal cual para los atributos que correspondan; NO los contradigas ni los reemplaces por otros):',
        ...filas.map(([k, v]) => `- ${k}: ${v}`),
    ].join('\n');
}
