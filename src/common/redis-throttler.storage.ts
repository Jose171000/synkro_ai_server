import { Inject, Injectable } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';

/**
 * Contador de peticiones respaldado en Redis.
 *
 * El almacenamiento por defecto vive en la memoria del proceso: si el
 * hosting levanta más de una instancia, cada una lleva su propia cuenta
 * y el límite se multiplica por el número de réplicas — justo lo que
 * hace inútil un límite pensado para frenar fuerza bruta. En Redis el
 * contador es único y además sobrevive a los reinicios.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
    constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) { }

    async increment(
        key: string,
        ttl: number,
        limit: number,
        blockDuration: number,
        throttlerName: string,
    ): Promise<ThrottlerStorageRecord> {
        const hitsKey = `throttle:${throttlerName}:${key}`;
        const blockKey = `throttle:block:${throttlerName}:${key}`;

        // Si ya está bloqueado, no se sigue contando
        const blockTtl = await this.redis.pttl(blockKey);
        if (blockTtl > 0) {
            return {
                totalHits: limit + 1,
                timeToExpire: Math.ceil(blockTtl / 1000),
                isBlocked: true,
                timeToBlockExpire: Math.ceil(blockTtl / 1000),
            };
        }

        const results = await this.redis
            .multi()
            .incr(hitsKey)
            .pttl(hitsKey)
            .exec();

        const totalHits = Number(results?.[0]?.[1] ?? 1);
        let remainingTtl = Number(results?.[1]?.[1] ?? -1);

        // Primera petición de la ventana: se le pone caducidad
        if (remainingTtl < 0) {
            await this.redis.pexpire(hitsKey, ttl);
            remainingTtl = ttl;
        }

        const isBlocked = totalHits > limit;
        if (isBlocked) {
            await this.redis.set(blockKey, '1', 'PX', blockDuration || ttl);
        }

        return {
            totalHits,
            timeToExpire: Math.ceil(remainingTtl / 1000),
            isBlocked,
            timeToBlockExpire: isBlocked ? Math.ceil((blockDuration || ttl) / 1000) : 0,
        };
    }
}
