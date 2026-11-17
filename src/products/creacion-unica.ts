import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';

/** Lo mínimo de Redis que usa (así se prueba con uno falso). */
export interface RedisDeCreacion {
    set(clave: string, valor: string, ...args: any[]): Promise<any>;
    get(clave: string): Promise<string | null>;
    del(clave: string): Promise<any>;
}

/** Cuánto se recuerda una creación: si la persona sale y vuelve a pulsar «Generar con IA» en este tiempo, es la misma petición. */
export const VIDA_DE_CREACION_S = 15 * 60;
const GENERANDO = '__generando__';

/**
 * Huella de una petición de «Generar con IA»: las fotos por su CONTENIDO (no por su nombre, que cambia) más lo que la persona escribió.
 * Dos pulsaciones con las mismas fotos y los mismos datos dan la misma huella, en cualquier orden de las fotos.
 */
export function huellaDeCreacion(fotos: Buffer[], datos: Record<string, any>): string {
    const h = createHash('sha256');
    for (const hash of fotos.map((f) => createHash('sha256').update(f).digest('hex')).sort()) h.update(hash);
    const limpio = Object.fromEntries(
        Object.entries(datos ?? {})
            .filter(([k, v]) => k !== 'images' && v !== undefined && v !== null && String(v).trim() !== '')
            .map(([k, v]) => [k, Array.isArray(v) ? [...v].map(String).sort() : typeof v === 'string' ? v.trim() : v])
            .sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
    h.update(JSON.stringify(limpio));
    return h.digest('hex');
}

/**
 * Evita crear el mismo producto dos veces cuando la persona vuelve a pulsar «Generar con IA» (por ejemplo tras salir de la pantalla):
 * la segunda petición idéntica recibe el producto ya creado, o un aviso si el primero todavía se está generando.
 */
@Injectable()
export class CreacionUnica {
    constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) { }

    private clave(tienda: string, huella: string) { return `crear-ia:${tienda}:${huella}`; }

    /**
     * Ejecuta `crear` una sola vez por huella. `existente` recupera un producto ya creado por su id (null si ya no existe).
     * Si Redis falla, no se bloquea nada: se crea como siempre.
     */
    async unaSolaVez<T extends { id: string }>(
        tienda: string, huella: string,
        crear: () => Promise<T>,
        existente: (id: string) => Promise<T | null>,
        redisDePrueba?: RedisDeCreacion,
    ): Promise<T> {
        const redis = (redisDePrueba ?? this.redis) as RedisDeCreacion;
        const clave = this.clave(tienda, huella);
        let reservado = false;
        try {
            reservado = (await redis.set(clave, GENERANDO, 'EX', VIDA_DE_CREACION_S, 'NX')) === 'OK';
            if (!reservado) {
                const previo = await redis.get(clave);
                if (previo === GENERANDO) {
                    throw new ConflictException('Este producto ya se está generando: espera a que termine y lo verás en Productos. No hace falta volver a pulsar Generar con IA.');
                }
                if (previo) {
                    const ya = await existente(previo).catch(() => null);
                    if (ya) return ya;
                    // El producto ya no existe (lo eliminaron): se puede crear de nuevo.
                    await redis.set(clave, GENERANDO, 'EX', VIDA_DE_CREACION_S);
                    reservado = true;
                }
            }
        } catch (error) {
            if (error instanceof ConflictException) throw error;
            reservado = false; // Redis no responde: se crea sin protección en vez de impedirlo
        }

        try {
            const creado = await crear();
            if (reservado) await redis.set(clave, creado.id, 'EX', VIDA_DE_CREACION_S).catch(() => undefined);
            return creado;
        } catch (error) {
            // Si falló, se libera: reintentar debe poder crearlo.
            if (reservado) await redis.del(clave).catch(() => undefined);
            throw error;
        }
    }
}
