import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './batch-notification.service';

/** Lo mínimo de Redis que usa el coordinador (así se puede probar con uno falso). */
export interface RedisMinimo {
    set(clave: string, valor: string, ...args: any[]): Promise<any>;
    get(clave: string): Promise<string | null>;
}

export type TurnoDeCategoria =
    /** A este producto le toca decidir la categoría del grupo (los demás esperan su resultado). */
    | { rol: 'jefe' }
    /** Otro producto del mismo grupo ya la decidió: `categorias` son las del grupo. */
    | { rol: 'seguidor'; categorias: Record<string, string> }
    /** No hubo resultado a tiempo (o el que decidía falló): este producto se categoriza por su cuenta. */
    | { rol: 'solo' };

const VIDA_S = 86_400;
const MARCA_DE_FALLO = '__fallo__';

/**
 * Carga masiva: las filas que comparten «sku_padre» son variantes de un mismo producto y deben tener UNA sola categoría por canal.
 * La primera fila en procesarse decide las categorías (una sola llamada de categorización) y las demás las usan tal cual, aunque se
 * procesen en paralelo. Si quien decidía falla, los demás no se quedan esperando: se categorizan por su cuenta.
 */
@Injectable()
export class CategoriaUnicaDeLote {
    constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) { }

    private claveDeTurno(lote: string, grupo: string) { return `catgrupo:${lote}:${grupo.toLowerCase()}:turno`; }
    private claveDeCategorias(lote: string, grupo: string) { return `catgrupo:${lote}:${grupo.toLowerCase()}:categorias`; }

    /**
     * Pide el turno para decidir las categorías del grupo. `quien` identifica al trabajo (un reintento del mismo trabajo vuelve a ser el jefe).
     * Un seguidor espera hasta `esperaMaxMs` a que el jefe publique; si no llega, sigue por su cuenta.
     */
    async turno(lote: string, grupo: string, quien: string, opciones: { esperaMaxMs?: number; sondeoMs?: number; redis?: RedisMinimo } = {}): Promise<TurnoDeCategoria> {
        const redis = (opciones.redis ?? this.redis) as RedisMinimo;
        const esperaMax = opciones.esperaMaxMs ?? 120_000;
        const sondeo = opciones.sondeoMs ?? 2_000;
        const turno = this.claveDeTurno(lote, grupo);

        const ocupado = await redis.set(turno, quien, 'EX', VIDA_S, 'NX');
        if (ocupado === 'OK') return { rol: 'jefe' };
        if ((await redis.get(turno)) === quien) return { rol: 'jefe' };

        const inicio = Date.now();
        for (;;) {
            const guardado = await redis.get(this.claveDeCategorias(lote, grupo));
            if (guardado === MARCA_DE_FALLO) return { rol: 'solo' };
            if (guardado) {
                try { return { rol: 'seguidor', categorias: JSON.parse(guardado) as Record<string, string> }; } catch { return { rol: 'solo' }; }
            }
            if (Date.now() - inicio >= esperaMax) return { rol: 'solo' };
            await new Promise((r) => setTimeout(r, sondeo));
        }
    }

    /** El jefe publica las categorías del grupo para que las usen las demás filas. */
    async publicar(lote: string, grupo: string, categorias: Record<string, string>, redis: RedisMinimo = this.redis as RedisMinimo): Promise<void> {
        await redis.set(this.claveDeCategorias(lote, grupo), JSON.stringify(categorias ?? {}), 'EX', VIDA_S);
    }

    /** El jefe falló: se avisa para que las demás filas no esperen en vano. */
    async fallo(lote: string, grupo: string, redis: RedisMinimo = this.redis as RedisMinimo): Promise<void> {
        await redis.set(this.claveDeCategorias(lote, grupo), MARCA_DE_FALLO, 'EX', VIDA_S);
    }
}
