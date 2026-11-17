/**
 * Publicación masiva: qué le falta a cada producto seleccionado en cada cuenta de canal conectada y si está listo para enviarse.
 * Son funciones puras (sin base de datos) para poder probarlas; el servicio solo las alimenta y encola lo que sale «listo».
 */

/** Canales donde la publicación masiva puede enviar. Ripley además depende de los interruptores del servidor (ver `ripleyDisponible`). */
export const CANALES_DE_PUBLICACION_MASIVA = ['mercadolibre', 'falabella', 'woocommerce', 'ripley'] as const;

/**
 * Ripley solo recibe envíos con RIPLEY_PUBLISH_ENABLED=true y una lista de SKU permitidos (RIPLEY_PUBLISH_SKUS, o «*» para todos).
 * Devuelve por qué no está disponible, o null si lo está.
 */
export function motivoRipleyNoDisponible(env: NodeJS.ProcessEnv = process.env): string | null {
    if (env.RIPLEY_PUBLISH_ENABLED !== 'true') return 'La publicación en Ripley está apagada en el servidor (RIPLEY_PUBLISH_ENABLED).';
    if (!String(env.RIPLEY_PUBLISH_SKUS ?? '').trim()) return 'No hay SKU permitidos para publicar en Ripley (RIPLEY_PUBLISH_SKUS).';
    return null;
}

/** Un producto con lo que hace falta mirar de él. */
export interface MiembroParaPublicar {
    id: string;
    sku: string;
    price: number | string | null | undefined;
    fotos: number;
    /** Categorías ya elegidas por canal: { falabella: '3223' } */
    categorias: Record<string, string>;
    /** Ripley: ya se le mandó un envío de catálogo (queda pendiente de que Ripley lo apruebe): no se repite. */
    ripleyEnviado?: boolean;
}

export interface EnlaceDeCanal {
    syncStatus: string;
    updatedAt: Date | string;
}

export type EstadoDeMiembro = 'publicado' | 'en_proceso' | 'listo' | 'incompleto';

/** Un envío que sigue «pendiente» desde hace poco todavía lo está procesando el canal: no se manda otro. */
export const MINUTOS_EN_PROCESO = 15;

export function estadoDeMiembro(canal: string, m: MiembroParaPublicar, enlace: EnlaceDeCanal | undefined, ahora = Date.now()): { estado: EstadoDeMiembro; motivos: string[] } {
    if (enlace) {
        if (enlace.syncStatus === 'published' || enlace.syncStatus === 'paused') return { estado: 'publicado', motivos: [] };
        if (enlace.syncStatus === 'pending' && ahora - new Date(enlace.updatedAt).getTime() < MINUTOS_EN_PROCESO * 60_000) return { estado: 'en_proceso', motivos: [] };
    }
    if (canal === 'ripley' && m.ripleyEnviado) return { estado: 'en_proceso', motivos: [] };
    const motivos: string[] = [];
    if (m.price === null || m.price === undefined || m.price === '' || !(Number(m.price) > 0)) motivos.push('sin precio');
    if (!(m.fotos > 0)) motivos.push('sin fotos');
    if (canal === 'falabella' && !String(m.categorias?.falabella ?? '').trim()) motivos.push('sin categoría de Falabella (usa «Preparar para Falabella»)');
    if (canal === 'ripley' && !String(m.categorias?.ripley ?? '').trim()) motivos.push('sin categoría de Ripley (usa «Preparar para Ripley»)');
    return motivos.length ? { estado: 'incompleto', motivos } : { estado: 'listo', motivos: [] };
}

export interface ResultadoDeFamilia {
    total: number;
    publicadas: number;
    enProceso: number;
    /** Variantes que se enviarían */
    porPublicar: number;
    /** Variantes a las que algo les falta, con su motivo */
    incompletas: { sku: string; motivos: string[] }[];
    /** 'nada': ya está todo en el canal · 'listo': se puede enviar · 'incompleto': hay que arreglar algo antes */
    estado: 'nada' | 'listo' | 'incompleto';
}

/**
 * Un producto con variantes se publica entero: si a UNA variante pendiente le falta algo, no se envía el grupo en ese canal
 * (se avisa con el motivo) en vez de dejarlo a medias.
 */
export function evaluarFamilia(canal: string, miembros: MiembroParaPublicar[], enlaces: Map<string, EnlaceDeCanal>, ahora = Date.now()): ResultadoDeFamilia {
    const r: ResultadoDeFamilia = { total: miembros.length, publicadas: 0, enProceso: 0, porPublicar: 0, incompletas: [], estado: 'nada' };
    for (const m of miembros) {
        const e = estadoDeMiembro(canal, m, enlaces.get(m.id), ahora);
        if (e.estado === 'publicado') r.publicadas++;
        else if (e.estado === 'en_proceso') r.enProceso++;
        else if (e.estado === 'listo') r.porPublicar++;
        else r.incompletas.push({ sku: m.sku, motivos: e.motivos });
    }
    if (r.incompletas.length) r.estado = 'incompleto';
    else if (r.porPublicar > 0) r.estado = 'listo';
    return r;
}
