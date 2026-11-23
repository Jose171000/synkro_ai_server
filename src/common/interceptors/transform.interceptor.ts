import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface Response<T> {
    data: T;
    statusCode: number;
}

/** El MCP habla su propio protocolo (JSON-RPC): envolver su respuesta la rompería. */
export const esRutaDeProtocolo = (url: string | undefined): boolean => /^\/api\/v1\/mcp(\/|\?|$)/.test(url ?? '');

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, Response<T>> {
    intercept(context: ExecutionContext, next: CallHandler): Observable<Response<T>> {
        if (esRutaDeProtocolo(context.switchToHttp().getRequest()?.originalUrl)) return next.handle();
        return next.handle().pipe(
            map(data => ({
                data,
                statusCode: context.switchToHttp().getResponse().statusCode,
                timestamp: new Date().toISOString(),
            })),
        );
    }
}
