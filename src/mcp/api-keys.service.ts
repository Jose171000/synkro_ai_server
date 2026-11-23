import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { IsNull, Repository } from 'typeorm';
import { cerrarDependencias, Permiso, PERMISOS } from '../stores/permissions';
import { StoresService } from '../stores/stores.service';
import { StoreApiKey } from './entities/store-api-key.entity';

/**
 * Lo único que una clave del MCP puede llevar. Es SOLO LECTURA a propósito: ninguna clave puede editar, publicar ni aprobar
 * nada hasta que esas herramientas existan y se decida abrirlas (docs/mcp.md).
 */
export const PERMISOS_MCP: readonly Permiso[] = ['productos.ver', 'canales.ver', 'ventas.ver', 'ventas.contacto', 'analiticas.ver', 'costos.ver'];

/** Lo que lleva una clave si no se dice otra cosa: sin datos de contacto de clientes ni costos. */
export const PERMISOS_MCP_POR_DEFECTO: readonly Permiso[] = ['productos.ver', 'canales.ver', 'ventas.ver', 'analiticas.ver'];

export const MAX_CLAVES_ACTIVAS = 10;
export const MAX_DIAS_DE_VIDA = 365;
const PREFIJO = 'syk_';

export const hashDeClave = (clave: string) => createHash('sha256').update(clave).digest('hex');

/** Los permisos que realmente tiene una clave: los suyos que además tiene hoy quien la creó. */
export function permisosEfectivosDeClave(deLaClave: readonly string[], deQuienLaCreo: readonly Permiso[]): Permiso[] {
    return PERMISOS.filter((p) => deLaClave.includes(p) && deQuienLaCreo.includes(p) && PERMISOS_MCP.includes(p));
}

/**
 * Los permisos que se piden al crear una clave, ya válidos: solo de lectura, con lo que cada uno necesita ya marcado y sin
 * nada que quien la crea no tenga.
 */
export function permisosParaClave(pedidos: unknown, deQuienLaCrea: readonly Permiso[]): Permiso[] {
    const lista = pedidos === undefined || pedidos === null ? [...PERMISOS_MCP_POR_DEFECTO] : Array.isArray(pedidos) ? pedidos : null;
    if (!lista) throw new BadRequestException('Los permisos deben ser una lista.');
    const fuera = [...new Set(lista.filter((p) => !PERMISOS_MCP.includes(p as Permiso)).map((p) => String(p).slice(0, 60)))];
    if (fuera.length) {
        throw new BadRequestException(`Estos permisos no se pueden dar a una clave del MCP: ${fuera.join(', ')}. Solo se permiten: ${PERMISOS_MCP.join(', ')}.`);
    }
    const permisos = cerrarDependencias(lista as Permiso[]);
    if (!permisos.length) throw new BadRequestException('La clave necesita al menos un permiso.');
    const sinTener = permisos.filter((p) => !deQuienLaCrea.includes(p));
    if (sinTener.length) throw new ForbiddenException(`No puedes dar a una clave permisos que tú no tienes: ${sinTener.join(', ')}.`);
    return permisos;
}

/** Quien llama al MCP, ya autenticado: la tienda, la clave y lo que puede hacer. */
export interface AccesoMcp {
    keyId: string;
    keyName: string;
    userId: string;
    storeId: string;
    role: 'owner' | 'editor' | 'viewer';
    permissions: Permiso[];
}

const UN_MINUTO = 60_000;

@Injectable()
export class ApiKeysService {
    constructor(
        @InjectRepository(StoreApiKey) private readonly keys: Repository<StoreApiKey>,
        private readonly stores: StoresService,
    ) { }

    /** Crea una clave. Devuelve la clave completa UNA sola vez: después no hay manera de verla. */
    async crear(userId: string, storeId: string, dto: { name?: string; permissions?: unknown; expiresInDays?: number }) {
        // Gestionar claves es del dueño, como el equipo y los roles: se comprueba por rol.
        const acceso = await this.stores.requireAccess(userId, storeId, 'owner');

        const name = String(dto.name ?? '').trim();
        if (name.length < 2 || name.length > 60 || /[<>]/.test(name)) {
            throw new BadRequestException('El nombre debe tener entre 2 y 60 caracteres y no puede llevar < ni >.');
        }
        const dias = dto.expiresInDays;
        if (dias !== undefined && dias !== null && (!Number.isInteger(dias) || dias < 1 || dias > MAX_DIAS_DE_VIDA)) {
            throw new BadRequestException(`La caducidad debe ser de 1 a ${MAX_DIAS_DE_VIDA} días.`);
        }
        const permisos = permisosParaClave(dto.permissions, acceso.permissions);

        const activas = await this.keys.count({ where: { store: { id: storeId }, revokedAt: IsNull() } });
        if (activas >= MAX_CLAVES_ACTIVAS) throw new BadRequestException(`Una tienda puede tener hasta ${MAX_CLAVES_ACTIVAS} claves activas. Revoca alguna antes de crear otra.`);

        const clave = PREFIJO + randomBytes(32).toString('base64url');
        const fila = await this.keys.save(this.keys.create({
            store: { id: storeId } as any,
            createdBy: { id: userId } as any,
            name,
            keyHash: hashDeClave(clave),
            prefix: clave.slice(0, 12),
            permissions: permisos,
            expiresAt: dias ? new Date(Date.now() + dias * 24 * 3600 * 1000) : null,
        }));
        return { ...this.presentar(fila), key: clave, warning: 'Guarda esta clave ahora: no se vuelve a mostrar.' };
    }

    async listar(userId: string, storeId: string) {
        await this.stores.requireAccess(userId, storeId, 'owner');
        const filas = await this.keys.find({ where: { store: { id: storeId } }, order: { createdAt: 'DESC' } });
        return filas.map((f) => this.presentar(f));
    }

    async revocar(userId: string, storeId: string, id: string) {
        await this.stores.requireAccess(userId, storeId, 'owner');
        const fila = await this.keys.findOne({ where: { id, store: { id: storeId } } });
        if (!fila) throw new NotFoundException('Clave no encontrada.');
        if (!fila.revokedAt) await this.keys.update({ id: fila.id }, { revokedAt: new Date() });
        return { id: fila.id, revoked: true };
    }

    /**
     * Valida la clave que llega en la cabecera y devuelve lo que puede hacer. Cada llamada vuelve a comprobar a quien la
     * creó: si ya no está en la tienda o su rol bajó, la clave pierde poder de inmediato.
     */
    async autenticar(clave: string | undefined): Promise<AccesoMcp> {
        const mala = new UnauthorizedException('Clave inválida, caducada o revocada.');
        if (!clave || !clave.startsWith(PREFIJO) || clave.length > 200) throw mala;

        const fila = await this.keys.findOne({ where: { keyHash: hashDeClave(clave) }, relations: { store: true, createdBy: true } });
        if (!fila || fila.revokedAt) throw mala;
        if (fila.expiresAt && fila.expiresAt.getTime() <= Date.now()) throw mala;

        const acceso = await this.stores.requireAccess(fila.createdBy.id, fila.store.id, 'viewer').catch(() => null);
        if (!acceso) throw mala;

        // Si su creador ya no puede ver nada de lo que la clave pedía, no hay nada que ofrecer: se dice claro en vez de callar.
        const permissions = permisosEfectivosDeClave(fila.permissions, acceso.permissions);
        if (!permissions.length) throw new ForbiddenException('Esta clave ya no tiene permisos: quien la creó perdió acceso a lo que permitía.');

        // Anotar el uso como mucho una vez por minuto, sin esperar ni poder hacer fallar la llamada.
        if (!fila.lastUsedAt || Date.now() - fila.lastUsedAt.getTime() > UN_MINUTO) {
            void this.keys.update({ id: fila.id }, { lastUsedAt: new Date() }).catch(() => undefined);
        }

        return {
            keyId: fila.id,
            keyName: fila.name,
            userId: fila.createdBy.id,
            storeId: fila.store.id,
            role: acceso.role,
            permissions,
        };
    }

    private presentar(f: StoreApiKey) {
        return {
            id: f.id,
            name: f.name,
            prefix: f.prefix,
            permissions: f.permissions,
            expiresAt: f.expiresAt,
            revokedAt: f.revokedAt,
            lastUsedAt: f.lastUsedAt,
            createdAt: f.createdAt,
        };
    }
}
