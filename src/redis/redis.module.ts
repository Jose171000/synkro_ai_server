import { Module, Global } from '@nestjs/common';
import Redis from 'ioredis';
import { RedisThrottlerStorage } from '../common/redis-throttler.storage';

import { REDIS_CLIENT } from './redis.constants';
export { REDIS_CLIENT };

@Global()
@Module({
    providers: [
        {
            provide: REDIS_CLIENT,
            useFactory: () => {
                const client = new Redis({
                    host: process.env.REDIS_HOST || '127.0.0.1',
                    port: parseInt(process.env.REDIS_PORT || '6379'),
                    password: process.env.REDIS_PASSWORD || undefined,
                    lazyConnect: true,
                });
                client.on('error', (err) =>
                    console.error('[Redis] Connection error:', err.message),
                );
                return client;
            },
        },
        RedisThrottlerStorage,
    ],
    exports: [REDIS_CLIENT, RedisThrottlerStorage],
})
export class RedisModule { }
