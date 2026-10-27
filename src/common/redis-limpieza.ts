import type Redis from 'ioredis';

/**
 * Registros de trabajos de BullMQ que ninguna cola usa (restos de incidentes o de antes de configurar la retención).
 *
 * Un trabajo vive como un hash «bull:<cola>:<número>» (más, a veces, «:logs» o «:lock») y se menciona en una de las listas
 * de la cola (en espera, activo, programado, completado, fallido…). Si ninguna lo menciona, nadie lo va a usar y solo ocupa
 * memoria. Esta limpieza lo comprueba dos veces y nunca toca uno reciente, y por defecto solo simula.
 */

/** Un trabajo reciente puede estar moviéndose entre listas justo ahora: solo se consideran los de más de este tiempo. */
export const EDAD_MINIMA_MS = 2 * 3600_000;
const TANDA_DE_BORRADO = 500;
const MUESTRA_PARA_TAMANO = 40;

export interface ResultadoDeLimpieza {
    cola: string;
    simulacion: boolean;
    clavesDeTrabajos: number;
    sueltas: number;
    sueltasAntiguas: number;
    borradas: number;
    /** Memoria estimada que libera (promedio de una muestra por la cantidad de claves). */
    bytesEstimados: number;
    /** Reparto de lo que hay: hash del trabajo, sus claves auxiliares, identificadores no numéricos. */
    composicion: { hash: number; auxiliares: number; otros: number };
}

/** «bull:cola:123» → { id: '123', sufijo: '' }; «bull:cola:123:logs» → sufijo 'logs'; otra cosa → null. */
export function leerClaveDeTrabajo(clave: string, cola: string): { id: string; sufijo: string } | null {
    const prefijo = `bull:${cola}:`;
    if (!clave.startsWith(prefijo)) return null;
    const m = clave.slice(prefijo.length).match(/^(\d+)(?::(.+))?$/);
    return m ? { id: m[1], sufijo: m[2] ?? '' } : null;
}

/** Los números de trabajo que alguna lista de la cola menciona. */
export async function trabajosEnUso(redis: Redis, cola: string): Promise<Set<string>> {
    const base = `bull:${cola}:`;
    const usados = new Set<string>();
    for (const zset of ['delayed', 'prioritized', 'completed', 'failed', 'waiting-children']) {
        for (const id of await redis.zrange(base + zset, 0, -1)) usados.add(id);
    }
    for (const lista of ['wait', 'active', 'paused']) {
        for (const id of await redis.lrange(base + lista, 0, -1)) usados.add(id);
    }
    for (const id of await redis.zrange(base + 'stalled', 0, -1).catch(() => [] as string[])) usados.add(id);
    return usados;
}

export async function limpiarTrabajosSueltos(redis: Redis, cola: string, opciones: { ejecutar?: boolean; max?: number } = {}): Promise<ResultadoDeLimpieza> {
    const ejecutar = !!opciones.ejecutar;
    const max = Math.max(1, opciones.max ?? 100_000);

    // 1) Todas las claves de trabajos de la cola.
    const hashes = new Map<string, string[]>();
    const composicion = { hash: 0, auxiliares: 0, otros: 0 };
    let cursor = '0';
    do {
        const [siguiente, lote] = await redis.scan(cursor, 'MATCH', `bull:${cola}:*`, 'COUNT', 2000);
        cursor = siguiente;
        for (const clave of lote) {
            const t = leerClaveDeTrabajo(clave, cola);
            if (!t) { composicion.otros++; continue; }
            if (t.sufijo) composicion.auxiliares++; else composicion.hash++;
            const lista = hashes.get(t.id) ?? [];
            lista.push(clave);
            hashes.set(t.id, lista);
        }
    } while (cursor !== '0');

    // 2) Cuáles menciona alguna lista (dos lecturas separadas por el recorrido anterior).
    const usados = await trabajosEnUso(redis, cola);
    const sueltas = [...hashes.keys()].filter((id) => !usados.has(id));

    // 3) Solo las antiguas: un trabajo reciente puede estar cambiando de lista en este momento.
    const limite = Date.now() - EDAD_MINIMA_MS;
    const antiguas: string[] = [];
    for (let i = 0; i < sueltas.length; i += 1000) {
        const grupo = sueltas.slice(i, i + 1000);
        const marcas = await redis.pipeline(grupo.map((id) => ['hget', `bull:${cola}:${id}`, 'timestamp'])).exec();
        grupo.forEach((id, n) => {
            const t = Number(marcas?.[n]?.[1]);
            // Sin fecha legible (hash incompleto) también es un resto: nadie lo puede usar.
            if (!Number.isFinite(t) || t === 0 || t < limite) antiguas.push(id);
        });
    }

    // Tamaño aproximado de lo que se libera.
    const muestra = antiguas.slice(0, MUESTRA_PARA_TAMANO);
    const tamanos: number[] = [];
    for (const id of muestra) {
        for (const clave of hashes.get(id) ?? []) {
            try { const b = await redis.call('MEMORY', 'USAGE', clave); if (typeof b === 'number') tamanos.push(b); } catch { /* sin dato */ }
        }
    }
    const clavesPorTrabajo = antiguas.length ? [...antiguas].reduce((n, id) => n + (hashes.get(id)?.length ?? 0), 0) / antiguas.length : 0;
    const promedio = tamanos.length ? tamanos.reduce((a, b) => a + b, 0) / tamanos.length : 0;
    const bytesEstimados = Math.round(promedio * clavesPorTrabajo * antiguas.length);

    // 4) Borrado (solo si se pidió), con la segunda lectura de «en uso» justo antes, por tandas y con tope.
    let borradas = 0;
    if (ejecutar) {
        const usadosAhora = await trabajosEnUso(redis, cola);
        const aBorrar = antiguas.filter((id) => !usadosAhora.has(id)).slice(0, max);
        for (let i = 0; i < aBorrar.length; i += TANDA_DE_BORRADO) {
            const claves = aBorrar.slice(i, i + TANDA_DE_BORRADO).flatMap((id) => hashes.get(id) ?? []);
            if (claves.length) borradas += await redis.unlink(...claves);
        }
    }

    return {
        cola,
        simulacion: !ejecutar,
        clavesDeTrabajos: composicion.hash + composicion.auxiliares,
        sueltas: sueltas.length,
        sueltasAntiguas: antiguas.length,
        borradas,
        bytesEstimados,
        composicion,
    };
}
