import type Redis from 'ioredis';
import { Queue } from 'bullmq';
import { COLAS } from './queue-maintenance.service';

/**
 * Qué ocupa Redis, solo de lectura: memoria usada, estado de sus copias en disco, cuántos trabajos hay en cada cola y
 * un reparto aproximado por tipo de dato. Sirve para saber si lo que llena el volumen es el historial de trabajos, trabajos
 * pendientes o otra cosa.
 */

export interface GrupoDeClaves {
    grupo: string;
    claves: number;
    /** Bytes estimados (promedio de una muestra por la cantidad de claves del grupo). */
    bytesEstimados: number;
}

/** Las listas propias de una cola de BullMQ; cualquier otra cosa tras «bull:<cola>:» es un trabajo (su número o su identificador). */
const LISTAS_DE_COLA = new Set(['id', 'meta', 'events', 'completed', 'failed', 'wait', 'active', 'delayed', 'paused', 'prioritized', 'stalled', 'stalled-check', 'limiter', 'marker', 'pc', 'repeat', 'de', 'metrics']);

/** A qué grupo pertenece una clave: «bull:<cola>:completed», «bull:<cola>:trabajos»… o su primer segmento. */
export function grupoDeClave(clave: string): string {
    const partes = clave.split(':');
    if (partes[0] === 'bull' && partes.length >= 3) {
        return LISTAS_DE_COLA.has(partes[2]) ? `bull:${partes[1]}:${partes[2]}` : `bull:${partes[1]}:trabajos`;
    }
    return partes[0].replace(/[0-9a-f]{8,}/gi, '*');
}

export function repartirPorGrupo(claves: string[]): Map<string, string[]> {
    const grupos = new Map<string, string[]>();
    for (const c of claves) {
        const g = grupoDeClave(c);
        const lista = grupos.get(g);
        if (lista) lista.push(c); else grupos.set(g, [c]);
    }
    return grupos;
}

const MAX_CLAVES_LEIDAS = 60_000;
const MUESTRA_POR_GRUPO = 15;

function campo(texto: string, nombre: string): string | null {
    const m = texto.match(new RegExp(`^${nombre}:(.*)$`, 'm'));
    return m ? m[1].trim() : null;
}

export async function diagnosticarRedis(redis: Redis) {
    const memoria = await redis.info('memory');
    const persistencia = await redis.info('persistence');
    const total = await redis.dbsize();

    // Lectura por tandas, con tope: no debe cargar a Redis.
    const claves: string[] = [];
    let cursor = '0';
    do {
        const [siguiente, lote] = await redis.scan(cursor, 'COUNT', 2000);
        cursor = siguiente;
        claves.push(...lote);
    } while (cursor !== '0' && claves.length < MAX_CLAVES_LEIDAS);

    const grupos: GrupoDeClaves[] = [];
    for (const [grupo, lista] of repartirPorGrupo(claves)) {
        const muestra = lista.slice(0, MUESTRA_POR_GRUPO);
        const tamanos: number[] = [];
        for (const k of muestra) {
            try { const b = await redis.call('MEMORY', 'USAGE', k); if (typeof b === 'number') tamanos.push(b); } catch { /* sin dato */ }
        }
        const promedio = tamanos.length ? tamanos.reduce((a, b) => a + b, 0) / tamanos.length : 0;
        grupos.push({ grupo, claves: lista.length, bytesEstimados: Math.round(promedio * lista.length) });
    }
    grupos.sort((a, b) => b.bytesEstimados - a.bytesEstimados);

    // Trabajos de cada cola.
    const connection = {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD || undefined,
    };
    const colas: Record<string, Record<string, number>> = {};
    for (const nombre of COLAS) {
        const q = new Queue(nombre, { connection });
        try { colas[nombre] = await q.getJobCounts('wait', 'active', 'delayed', 'completed', 'failed', 'paused'); }
        catch (error: any) { colas[nombre] = { error: -1 }; }
        finally { await q.close().catch(() => undefined); }
    }

    return {
        memoriaUsada: campo(memoria, 'used_memory_human'),
        memoriaMaxima: campo(memoria, 'maxmemory_human'),
        clavesEnTotal: total,
        clavesLeidas: claves.length,
        persistencia: {
            ultimaCopia: campo(persistencia, 'rdb_last_bgsave_status'),
            aofActivo: campo(persistencia, 'aof_enabled'),
            tamanoUltimaCopiaBytes: campo(persistencia, 'rdb_last_cow_size'),
            copiaEnCurso: campo(persistencia, 'rdb_bgsave_in_progress'),
        },
        colas,
        grupos: grupos.slice(0, 25),
    };
}
