import { BadRequestException, ConflictException, Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes, randomUUID } from 'crypto';
import Redis from 'ioredis';
import { Repository } from 'typeorm';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { Store } from '../stores/entities/store.entity';
import { StoresService } from '../stores/stores.service';
import { UploadService } from '../upload/upload.service';
import type { AccesoMcp } from './api-keys.service';
import { StoreApiKey } from './entities/store-api-key.entity';

/** Cuánto sirve el enlace para subir fotos. */
export const MINUTOS_DEL_ENLACE = 30;
export const MAX_FOTOS_POR_SUBIDA = 30;
/** Cuánto se recuerdan las fotos ya subidas, para usarlas al crear productos. */
const VIDA_DE_FOTOS_S = 24 * 3600;

export interface SesionDeSubida {
    hash: string;
    subidaId: string;
    storeId: string;
    userId: string;
    keyId: string;
}

export interface FotoSubida {
    n: number;
    nombre: string;
    url: string;
}

const hashDe = (token: string) => createHash('sha256').update(token).digest('hex');

/** La dirección pública de este servidor: la misma que ya usan los avisos de Falabella. */
export function direccionPublica(env: NodeJS.ProcessEnv = process.env): string {
    const configurada = (env.PUBLIC_API_URL || '').replace(/\/+$/, '');
    if (configurada) return configurada;
    return env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '';
}

/**
 * Enlaces para que la persona suba fotos desde su celular o su PC y el asistente las use. El enlace lleva un secreto que
 * solo sirve para ESA subida: caduca en 30 minutos y se gasta al subir. El secreto va detrás de `#`, así no queda en los
 * registros del servidor.
 */
@Injectable()
export class SubidaDeFotosService {
    constructor(
        @Inject(REDIS_CLIENT) private readonly redis: Redis,
        @InjectRepository(StoreApiKey) private readonly keys: Repository<StoreApiKey>,
        @InjectRepository(Store) private readonly tiendas: Repository<Store>,
        private readonly stores: StoresService,
        private readonly upload: UploadService,
    ) { }

    async crearEnlace(acceso: AccesoMcp) {
        const base = direccionPublica();
        if (!base) throw new ServiceUnavailableException('No se pueden crear enlaces de subida: falta configurar la dirección pública del servidor (PUBLIC_API_URL).');
        const token = randomBytes(32).toString('base64url');
        const subidaId = randomUUID();
        const sesion = { subidaId, storeId: acceso.storeId, userId: acceso.userId, keyId: acceso.keyId };
        await this.redis.set(`mcp:sub:${hashDe(token)}`, JSON.stringify(sesion), 'EX', MINUTOS_DEL_ENLACE * 60);
        await this.redis.set(this.claveDeResultado(acceso.storeId, subidaId), '[]', 'EX', VIDA_DE_FOTOS_S);
        return {
            subidaId,
            enlace: `${base}/api/v1/mcp/subir-fotos#${token}`,
            validoMinutos: MINUTOS_DEL_ENLACE,
            instrucciones: 'Da este enlace a la persona para que lo abra y suba sus fotos. Cuando diga que terminó, llama a ver_fotos_subidas con subidaId.',
        };
    }

    /** La sesión del enlace, comprobando que la clave y los permisos de quien la creó sigan vigentes. */
    async sesion(token: string | undefined): Promise<SesionDeSubida> {
        const mala = new UnauthorizedException('Este enlace ya se usó o caducó. Pide uno nuevo a tu asistente.');
        if (!token || token.length > 100) throw mala;
        const hash = hashDe(token);
        const guardada = await this.redis.get(`mcp:sub:${hash}`);
        if (!guardada) throw mala;
        const sesion: SesionDeSubida = { ...JSON.parse(guardada), hash };

        const clave = await this.keys.findOne({ where: { id: sesion.keyId }, select: { id: true, revokedAt: true, expiresAt: true } });
        if (!clave || clave.revokedAt || (clave.expiresAt && clave.expiresAt.getTime() <= Date.now())) throw mala;
        const acceso = await this.stores.requireAccess(sesion.userId, sesion.storeId, 'viewer').catch(() => null);
        if (!acceso?.permissions.includes('productos.editar')) throw mala;
        return sesion;
    }

    /** Lo que la página muestra antes de subir: para qué tienda es. */
    async datos(sesion: SesionDeSubida) {
        const tienda = await this.tiendas.findOne({ where: { id: sesion.storeId }, select: { id: true, name: true } });
        return { tienda: tienda?.name ?? '', maximo: MAX_FOTOS_POR_SUBIDA };
    }

    async subir(sesion: SesionDeSubida, archivos: Express.Multer.File[]): Promise<{ subidas: number }> {
        if (!archivos?.length) throw new BadRequestException('Elige al menos una foto.');
        if (archivos.length > MAX_FOTOS_POR_SUBIDA) throw new BadRequestException(`Máximo ${MAX_FOTOS_POR_SUBIDA} fotos.`);
        // Dos envíos a la vez del mismo enlace: solo entra uno.
        const candado = `mcp:sub:uso:${sesion.hash}`;
        if ((await this.redis.set(candado, '1', 'EX', 300, 'NX')) !== 'OK') throw new ConflictException('Estas fotos ya se están subiendo.');
        try {
            const resultados = await this.upload.uploadImages(archivos, 'products');
            const fotos: FotoSubida[] = resultados.map((r, i) => ({ n: i + 1, nombre: String(archivos[i].originalname ?? '').slice(0, 120), url: r.secureUrl }));
            await this.redis.set(this.claveDeResultado(sesion.storeId, sesion.subidaId), JSON.stringify(fotos), 'EX', VIDA_DE_FOTOS_S);
            await this.redis.sadd(`mcp:fotos:${sesion.storeId}`, ...fotos.map((f) => f.url));
            await this.redis.expire(`mcp:fotos:${sesion.storeId}`, VIDA_DE_FOTOS_S);
            await this.redis.del(`mcp:sub:${sesion.hash}`);
            return { subidas: fotos.length };
        } finally {
            await this.redis.del(candado).catch(() => undefined);
        }
    }

    /** Lo que se subió con un enlace de ESTA tienda. */
    async fotosDe(storeId: string, subidaId: string): Promise<FotoSubida[]> {
        const guardado = await this.redis.get(this.claveDeResultado(storeId, subidaId));
        if (!guardado) throw new BadRequestException('No hay ninguna subida con ese id en esta tienda (se recuerdan 24 horas).');
        return JSON.parse(guardado);
    }

    /** De estas direcciones, cuáles son fotos que la persona subió a esta tienda (no hay que volver a descargarlas). */
    async yaSubidas(storeId: string, urls: string[]): Promise<Set<string>> {
        const esta = await Promise.all(urls.map((u) => this.redis.sismember(`mcp:fotos:${storeId}`, u).catch(() => 0)));
        return new Set(urls.filter((_, i) => esta[i] === 1));
    }

    private claveDeResultado(storeId: string, subidaId: string) {
        return `mcp:sub:res:${storeId}:${subidaId}`;
    }
}
