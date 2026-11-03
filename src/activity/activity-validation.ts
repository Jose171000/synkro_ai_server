import { DISPOSITIVOS, MAX_EVENTOS_POR_LOTE, TipoDelNavegador, TIPOS_DEL_NAVEGADOR } from './activity.constants';

/**
 * Lo que el navegador manda se trata como no confiable: se limpia y se descarta lo que no cumple. Aquí está la regla que
 * protege la privacidad: los nombres de pantallas y elementos son etiquetas («ventas.descargar»), nunca contenido.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EventoValido {
    type: TipoDelNavegador;
    at: Date;
    screen: string;
    element: string | null;
    /** Posición del clic y del elemento dentro de la pantalla, en milésimas (0-1000). */
    x: number | null;
    y: number | null;
    ex: number | null;
    ey: number | null;
    ew: number | null;
    eh: number | null;
    /** Segundos de actividad (solo en los «ping»). */
    value: number | null;
}

export interface LoteValido {
    sessionId: string;
    storeId: string | null;
    device: (typeof DISPOSITIVOS)[number];
    eventos: EventoValido[];
    descartados: number;
}

/**
 * Convierte un texto en una etiqueta: minúsculas, sin tildes, solo letras, números y «. _ : -». Se rechaza (null) lo que
 * parece un dato personal o un identificador: correos, números largos (teléfonos, documentos, pedidos) o UUID.
 */
export function limpiarEtiqueta(valor: unknown, max = 80): string | null {
    if (typeof valor !== 'string') return null;
    const bruto = valor.trim();
    if (!bruto || bruto.includes('@') || UUID.test(bruto)) return null;
    const etiqueta = bruto
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9._:]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, max);
    if (!etiqueta || /\d{5,}/.test(etiqueta)) return null;
    return etiqueta;
}

const milesimas = (v: unknown): number | null => {
    const n = Number(v);
    return v !== null && v !== undefined && Number.isFinite(n) && n >= 0 && n <= 1000 ? Math.round(n) : null;
};

export function esUuid(v: unknown): v is string {
    return typeof v === 'string' && UUID.test(v);
}

/** Valida un lote de eventos del navegador. Lo que no sirve se descarta sin romper el resto. */
export function validarLote(body: any, ahora: Date = new Date()): LoteValido | null {
    if (!body || typeof body !== 'object' || !esUuid(body.sessionId)) return null;
    const crudos: any[] = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTOS_POR_LOTE) : [];
    const desdeMs = ahora.getTime() - 15 * 60_000;
    const hastaMs = ahora.getTime() + 60_000;

    const eventos: EventoValido[] = [];
    let descartados = Math.max(0, (Array.isArray(body.events) ? body.events.length : 0) - crudos.length);
    for (const e of crudos) {
        const tipo = e?.t;
        const screen = limpiarEtiqueta(e?.screen, 60);
        if (!TIPOS_DEL_NAVEGADOR.includes(tipo) || !screen) { descartados++; continue; }

        const element = tipo === 'click' ? limpiarEtiqueta(e?.element, 80) ?? 'otros' : null;
        let value: number | null = null;
        if (tipo === 'ping') {
            const s = Number(e?.v);
            if (!Number.isFinite(s) || s < 1 || s > 120) { descartados++; continue; }
            value = Math.round(s);
        }
        const marca = Number(e?.at);
        const at = Number.isFinite(marca) && marca >= desdeMs && marca <= hastaMs ? new Date(marca) : ahora;

        eventos.push({
            type: tipo, at, screen, element,
            x: tipo === 'click' ? milesimas(e?.x) : null,
            y: tipo === 'click' ? milesimas(e?.y) : null,
            ex: tipo === 'click' ? milesimas(e?.ex) : null,
            ey: tipo === 'click' ? milesimas(e?.ey) : null,
            ew: tipo === 'click' ? milesimas(e?.ew) : null,
            eh: tipo === 'click' ? milesimas(e?.eh) : null,
            value,
        });
    }

    return {
        sessionId: body.sessionId.toLowerCase(),
        storeId: esUuid(body.storeId) ? body.storeId.toLowerCase() : null,
        device: DISPOSITIVOS.includes(body.device) ? body.device : 'escritorio',
        eventos,
        descartados,
    };
}
