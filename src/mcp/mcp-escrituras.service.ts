import { ConflictException, HttpException, HttpStatus, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import Redis from 'ioredis';
import { Repository } from 'typeorm';
import { REDIS_CLIENT } from '../redis/redis.constants';
import type { AccesoMcp } from './api-keys.service';
import { McpWriteLog } from './entities/mcp-write-log.entity';

/** Topes de escritura: frenan un asistente que entra en bucle antes de que llene el catálogo o gaste en IA. */
export const MAX_ESCRITURAS_POR_HORA = 30;
export const MAX_ESCRITURAS_POR_DIA = 200;
export const MAX_IA_POR_DIA = 20;
/** Cuánto se recuerda una creación: la misma petición repetida en este tiempo devuelve lo ya creado. */
export const VIDA_DE_REPETICION_S = 15 * 60;
const EN_CURSO = '__en_curso__';

export interface Escritura {
    herramienta: string;
    args: unknown;
    resumen: Record<string, unknown>;
    /** true en lo que CREA: repetir la petición no debe crear dos veces. */
    unaSolaVez?: boolean;
    usaIa?: boolean;
}

/** JSON con las claves ordenadas: la misma petición da la misma huella aunque cambie el orden. */
const estable = (v: any): string =>
    Array.isArray(v) ? `[${v.map(estable).join(',')}]`
        : v && typeof v === 'object' ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${estable(v[k])}`).join(',')}}`
            : JSON.stringify(v ?? null);

const demasiadas = (texto: string) => new HttpException(texto, HttpStatus.TOO_MANY_REQUESTS);

/**
 * Por aquí pasa TODA escritura del MCP: no repetir creaciones, aplicar topes y dejar registro. Si Redis o el registro
 * fallan, no se escribe (a diferencia de las lecturas: aquí es preferible negarse).
 */
@Injectable()
export class McpEscriturasService {
    private readonly logger = new Logger(McpEscriturasService.name);

    constructor(
        @Inject(REDIS_CLIENT) private readonly redis: Redis,
        @InjectRepository(McpWriteLog) private readonly registro: Repository<McpWriteLog>,
    ) { }

    async ejecutar<T>(acceso: AccesoMcp, escritura: Escritura, hacer: () => Promise<T>): Promise<T> {
        const huella = createHash('sha256').update(`${escritura.herramienta}|${estable(escritura.args)}`).digest('hex');
        const clave = `mcp:rep:${acceso.storeId}:${huella}`;
        let reservada = false;

        if (escritura.unaSolaVez) {
            reservada = (await this.conRedis(() => this.redis.set(clave, EN_CURSO, 'EX', VIDA_DE_REPETICION_S, 'NX'))) === 'OK';
            if (!reservada) {
                const previo = await this.conRedis(() => this.redis.get(clave));
                if (!previo || previo === EN_CURSO) throw new ConflictException('Esta misma creación ya está en curso: espera un momento y consulta listar_productos antes de repetirla.');
                return { ...JSON.parse(previo), repetida: 'Esta petición idéntica ya se había hecho hace poco: se devuelve lo creado entonces, no se creó otra vez.' };
            }
        }

        try {
            await this.comprobarTopes(acceso, escritura.usaIa === true);

            const fila = await this.registro.save(this.registro.create({
                storeId: acceso.storeId,
                keyId: acceso.keyId,
                keyName: acceso.keyName,
                userId: acceso.userId,
                tool: escritura.herramienta,
                resumen: escritura.resumen,
                estado: 'pendiente',
            }));

            let resultado: T;
            try {
                resultado = await hacer();
            } catch (error: any) {
                await this.cerrar(fila.id, { estado: 'error', mensaje: String(error?.message ?? error).slice(0, 500) });
                throw error;
            }
            const id = (resultado as any)?.id;
            await this.cerrar(fila.id, { estado: 'hecho', resumen: { ...escritura.resumen, ...(id ? { id } : {}) } });
            if (reservada) await this.redis.set(clave, JSON.stringify(resultado), 'EX', VIDA_DE_REPETICION_S).catch(() => undefined);
            return resultado;
        } catch (error) {
            // Si no llegó a hacerse, se libera: reintentar debe poder hacerlo.
            if (reservada) await this.redis.del(clave).catch(() => undefined);
            throw error;
        }
    }

    /** Las últimas escrituras de una tienda, para que el dueño vea qué hizo cada clave. */
    async recientes(storeId: string) {
        const filas = await this.registro.find({ where: { storeId }, order: { createdAt: 'DESC' }, take: 100 });
        return filas.map(({ id, keyId, keyName, tool, resumen, estado, mensaje, createdAt }) => ({ id, keyId, keyName, tool, resumen, estado, mensaje, createdAt }));
    }

    private async comprobarTopes(acceso: AccesoMcp, usaIa: boolean): Promise<void> {
        const ahora = new Date().toISOString();
        const hora = ahora.slice(0, 13);
        const dia = ahora.slice(0, 10);
        if ((await this.contar(`mcp:w:h:${acceso.keyId}:${hora}`, 3600)) > MAX_ESCRITURAS_POR_HORA) {
            throw demasiadas(`Esta clave llegó al máximo de ${MAX_ESCRITURAS_POR_HORA} cambios por hora. Inténtalo más tarde.`);
        }
        if ((await this.contar(`mcp:w:d:${acceso.storeId}:${dia}`, 86400)) > MAX_ESCRITURAS_POR_DIA) {
            throw demasiadas(`La tienda llegó al máximo de ${MAX_ESCRITURAS_POR_DIA} cambios por día hechos desde asistentes.`);
        }
        if (usaIa && (await this.contar(`mcp:ia:d:${acceso.storeId}:${dia}`, 86400)) > MAX_IA_POR_DIA) {
            throw demasiadas(`La tienda llegó al máximo de ${MAX_IA_POR_DIA} generaciones con IA por día desde asistentes. En la app puedes seguir generando.`);
        }
    }

    private contar(clave: string, segundos: number): Promise<number> {
        return this.conRedis(async () => {
            const n = await this.redis.incr(clave);
            if (n === 1) await this.redis.expire(clave, segundos);
            return n;
        });
    }

    private async conRedis<T>(hacer: () => Promise<T>): Promise<T> {
        try {
            return await hacer();
        } catch (error: any) {
            this.logger.error(`Redis no responde: ${error?.message}`);
            throw new ServiceUnavailableException('Ahora mismo no se pueden hacer cambios desde asistentes. Inténtalo en unos minutos.');
        }
    }

    private async cerrar(id: string, cambios: Partial<McpWriteLog>): Promise<void> {
        await this.registro.update({ id }, cambios as any).catch((e) => this.logger.error(`No se pudo cerrar el registro ${id}: ${e?.message}`));
    }
}
