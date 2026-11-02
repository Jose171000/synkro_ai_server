/**
 * DIAGNÓSTICO TEMPORAL: deja en el log cómo informa cada canal el costo del envío (quién lo pagó y cuánto costó), para
 * poder mostrar «envío cubierto por el comprador» y «cubierto por ti» con datos reales. No cambia nada ni guarda nada.
 * Se quita cuando ya se conocen los campos. Se apaga con DIAGNOSTICO_ENVIO=0.
 *
 * Nunca registra datos personales: no entra en nombres, direcciones, teléfonos, correos ni documentos, y solo muestra
 * valores sueltos (números o textos cortos) de campos que hablan de costos, precios, montos o tipo de envío.
 */

/** Campos que nunca se recorren: llevan datos de la persona que compra. */
const PERSONAL = /(name|nombre|address|direcc|phone|tel[eé]fono|email|mail|document|dni|ruc|nickname|comment|street|zip|postal|city|state|region|ward|neighborhood|latitude|longitude|geolocation|receiver|customer|buyer|remarks|delivery_?info|tracking|national)/i;
/** Campos que hablan de costos, montos o del tipo de envío. */
const DE_COSTO = /(cost|fee|ship|freight|price|amount|paid|discount|tax|free|currency|mode|type|method|logistic|promo|coupon|voucher|total|status|flex)/i;

const MAX_TEXTO = 40;
const MAX_LINEA = 1800;

/** Recorre el objeto y devuelve «ruta=valor» de los campos de costo; las llaves de nivel superior van aparte (solo sus nombres). */
export function camposDeCosto(objeto: unknown, profundidad = 5): string[] {
    const salida: string[] = [];
    const recorrer = (valor: unknown, ruta: string, nivel: number) => {
        if (valor === null || valor === undefined || nivel > profundidad) return;
        if (Array.isArray(valor)) {
            valor.slice(0, 5).forEach((v, i) => recorrer(v, `${ruta}[${i}]`, nivel + 1));
            return;
        }
        if (typeof valor === 'object') {
            for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
                if (PERSONAL.test(k)) continue;
                recorrer(v, ruta ? `${ruta}.${k}` : k, nivel + 1);
            }
            return;
        }
        const hoja = ruta.split('.').pop() ?? ruta;
        if (!DE_COSTO.test(hoja)) return;
        const t = String(valor);
        if (typeof valor === 'string' && t.length > MAX_TEXTO) return;
        salida.push(`${ruta}=${t}`);
    };
    recorrer(objeto, '', 0);
    return salida;
}

/** Los nombres de los campos de primer nivel, sin valores y sin los personales: sirve para saber qué trae el canal. */
export function nombresDeCampos(objeto: unknown): string[] {
    if (!objeto || typeof objeto !== 'object' || Array.isArray(objeto)) return [];
    return Object.keys(objeto as Record<string, unknown>).filter(k => !PERSONAL.test(k));
}

/** Una línea de log lista para leer en Railway. */
export function lineaDeDiagnostico(canal: string, titulo: string, objeto: unknown): string {
    const campos = camposDeCosto(objeto).join(' | ');
    const llaves = nombresDeCampos(objeto).join(',');
    return `[DIAG-ENVIO] ${canal} ${titulo} :: ${campos} :: llaves[${llaves}]`.slice(0, MAX_LINEA);
}

const usos: Record<string, number> = {};

/** Deja pasar solo las primeras `max` veces por canal en cada arranque del servidor, y nada en las pruebas. */
export function puedeDiagnosticar(canal: string, max: number): boolean {
    if (process.env.JEST_WORKER_ID || process.env.DIAGNOSTICO_ENVIO === '0') return false;
    usos[canal] = (usos[canal] ?? 0) + 1;
    return usos[canal] <= max;
}
