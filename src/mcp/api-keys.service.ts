import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { IsNull, Repository } from 'typeorm';
import { cerrarDependencias, Permiso, PERMISOS } from '../stores/permissions';
import { StoresService } from '../stores/stores.service';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/user-role';
import { StoreApiKey } from './entities/store-api-key.entity';
import { esPermisoPlataforma, PERMISOS_PLATAFORMA, PERMISOS_PLATAFORMA_POR_DEFECTO, PermisoPlataforma } from './permisos-plataforma';

/**
 * Lo único que una clave del MCP de tienda puede llevar. Es SOLO LECTURA a propósito: ninguna clave puede editar, publicar ni
 * aprobar nada hasta que esas herramientas existan y se decida abrirlas (docs/mcp.md).
 */
export const PERMISOS_MCP: readonly Permiso[] = ['productos.ver', 'canales.ver', 'ventas.ver', 'ventas.contacto', 'analiticas.ver', 'costos.ver'];

/** Lo que lleva una clave de tienda si no se dice otra cosa: sin datos de contacto de clientes ni costos. */
export const PERMISOS_MCP_POR_DEFECTO: readonly Permiso[] = ['productos.ver', 'canales.ver', 'ventas.ver', 'analiticas.ver'];

export const MAX_CLAVES_ACTIVAS = 10;
export const MAX_DIAS_DE_VIDA = 365;
/** Una clave de plataforma ve toda la agencia: caduca obligatoriamente y pronto. */
export const MAX_DIAS_PLATAFORMA = 90;
export const MAX_CLAVES_PLATAFORMA_ACTIVAS = 20;

/** Las claves de tienda empiezan por `syk_`; las de plataforma, por `sya_`: se reconocen a simple vista y no se confunden. */
export const PREFIJO_TIENDA = 'syk_';
export const PREFIJO_PLATAFORMA = 'sya_';

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

/** Lo que cada permiso de plataforma necesita: los costos de las ventas no sirven sin poder ver las tiendas. */
const DEPENDENCIAS_PLATAFORMA: Partial<Record<PermisoPlataforma, readonly PermisoPlataforma[]>> = { 'finanzas.ver': ['clientes.ver'] };

/** Los permisos que se piden al crear una clave de plataforma, ya válidos y con sus dependencias. */
export function permisosParaClavePlataforma(pedidos: unknown): PermisoPlataforma[] {
    const lista = pedidos === undefined || pedidos === null ? [...PERMISOS_PLATAFORMA_POR_DEFECTO] : Array.isArray(pedidos) ? pedidos : null;
    if (!lista) throw new BadRequestException('Los permisos deben ser una lista.');
    const fuera = [...new Set(lista.filter((p) => !esPermisoPlataforma(p)).map((p) => String(p).slice(0, 60)))];
    if (fuera.length) {
        throw new BadRequestException(`Estos permisos no existen para una clave de plataforma: ${fuera.join(', ')}. Solo se permiten: ${PERMISOS_PLATAFORMA.join(', ')}.`);
    }
    const marcados = new Set<PermisoPlataforma>(lista as PermisoPlataforma[]);
    for (const p of [...marcados]) (DEPENDENCIAS_PLATAFORMA[p] ?? []).forEach((d) => marcados.add(d));
    if (!marcados.size) throw new BadRequestException('La clave necesita al menos un permiso.');
    return PERMISOS_PLATAFORMA.filter((p) => marcados.has(p));
}

function validarNombre(nombre: unknown): string {
    const name = String(nombre ?? '').trim();
    if (name.length < 2 || name.length > 60 || /[<>]/.test(name)) {
        throw new BadRequestException('El nombre debe tener entre 2 y 60 caracteres y no puede llevar < ni >.');
    }
    return name;
}

function validarDias(dias: unknown, max: number, obligatorio: boolean): number | null {
    if (dias === undefined || dias === null) {
        if (obligatorio) throw new BadRequestException(`Una clave de plataforma debe caducar: de 1 a ${max} días.`);
        return null;
    }
    if (typeof dias !== 'number' || !Number.isInteger(dias) || dias < 1 || dias > max) {
        throw new BadRequestException(`La caducidad debe ser de 1 a ${max} días.`);
    }
    return dias;
}

/** Quien llama al MCP de una tienda, ya autenticado: la tienda, la clave y lo que puede hacer. */
export interface AccesoMcp {
    keyId: string;
    keyName: string;
    userId: string;
    storeId: string;
    role: 'owner' | 'editor' | 'viewer';
    permissions: Permiso[];
}

/** Quien llama al MCP de plataforma, ya autenticado: un superadmin y lo que su clave le deja ver de la agencia. */
export interface AccesoPlataforma {
    keyId: string;
    keyName: string;
    userId: string;
    permissions: PermisoPlataforma[];
}

export interface FiltroDeClaves {
    storeId?: string;
    kind?: 'store' | 'platform';
    estado?: 'activa' | 'revocada' | 'caducada';
}

const UN_MINUTO = 60_000;

const estadoDe = (f: { revokedAt: Date | null; expiresAt: Date | null }): 'activa' | 'revocada' | 'caducada' =>
    f.revokedAt ? 'revocada' : f.expiresAt && f.expiresAt.getTime() <= Date.now() ? 'caducada' : 'activa';

@Injectable()
export class ApiKeysService {
    private readonly logger = new Logger(ApiKeysService.name);

    constructor(
        @InjectRepository(StoreApiKey) private readonly keys: Repository<StoreApiKey>,
        private readonly stores: StoresService,
        @InjectRepository(User) private readonly users: Repository<User>,
    ) { }

    /** Solo un superadmin (rol `admin` HOY, no el que dijo el token al iniciar sesión). */
    private async exigirSuperadmin(userId: string): Promise<void> {
        const user = await this.users.findOne({ where: { id: userId }, select: { id: true, role: true, isActive: true } });
        if (!user || user.role !== UserRole.ADMIN || user.isActive === false) {
            throw new ForbiddenException('Solo un superadmin puede hacer esto.');
        }
    }

    // ── Claves de tienda ─────────────────────────────────────────

    /** Crea una clave. Devuelve la clave completa UNA sola vez: después no hay manera de verla. */
    async crear(userId: string, storeId: string, dto: { name?: string; permissions?: unknown; expiresInDays?: number }) {
        // Gestionar claves es del dueño, como el equipo y los roles: se comprueba por rol.
        const acceso = await this.stores.requireAccess(userId, storeId, 'owner');

        const name = validarNombre(dto.name);
        const dias = validarDias(dto.expiresInDays, MAX_DIAS_DE_VIDA, false);
        const permisos = permisosParaClave(dto.permissions, acceso.permissions);

        const activas = await this.keys.count({ where: { kind: 'store', store: { id: storeId }, revokedAt: IsNull() } });
        if (activas >= MAX_CLAVES_ACTIVAS) throw new BadRequestException(`Una tienda puede tener hasta ${MAX_CLAVES_ACTIVAS} claves activas. Revoca alguna antes de crear otra.`);

        const clave = PREFIJO_TIENDA + randomBytes(32).toString('base64url');
        const fila = await this.keys.save(this.keys.create({
            kind: 'store',
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
        const filas = await this.keys.find({ where: { kind: 'store', store: { id: storeId } }, order: { createdAt: 'DESC' } });
        return filas.map((f) => this.presentar(f));
    }

    async revocar(userId: string, storeId: string, id: string) {
        await this.stores.requireAccess(userId, storeId, 'owner');
        const fila = await this.keys.findOne({ where: { id, kind: 'store', store: { id: storeId } } });
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
        if (!clave || !clave.startsWith(PREFIJO_TIENDA) || clave.length > 200) throw mala;

        // Solo los ids de la tienda y de quien la creó: no hace falta (ni conviene) traer sus filas completas, con datos de la cuenta.
        const fila = await this.keys.findOne({
            where: { keyHash: hashDeClave(clave) },
            relations: { store: true, createdBy: true },
            select: { id: true, name: true, kind: true, permissions: true, expiresAt: true, revokedAt: true, lastUsedAt: true, store: { id: true }, createdBy: { id: true } },
        });
        if (!fila || fila.kind !== 'store' || !fila.store || fila.revokedAt) throw mala;
        if (fila.expiresAt && fila.expiresAt.getTime() <= Date.now()) throw mala;

        const acceso = await this.stores.requireAccess(fila.createdBy.id, fila.store.id, 'viewer').catch(() => null);
        if (!acceso) throw mala;

        // Si su creador ya no puede ver nada de lo que la clave pedía, no hay nada que ofrecer: se dice claro en vez de callar.
        const permissions = permisosEfectivosDeClave(fila.permissions, acceso.permissions);
        if (!permissions.length) throw new ForbiddenException('Esta clave ya no tiene permisos: quien la creó perdió acceso a lo que permitía.');

        this.anotarUso(fila);

        return {
            keyId: fila.id,
            keyName: fila.name,
            userId: fila.createdBy.id,
            storeId: fila.store.id,
            role: acceso.role,
            permissions,
        };
    }

    // ── Claves de plataforma (superadmin) ────────────────────────

    /** Crea una clave de plataforma. Solo un superadmin; caduca obligatoriamente (máx. 90 días). La clave se ve UNA sola vez. */
    async crearPlataforma(userId: string, dto: { name?: string; permissions?: unknown; expiresInDays?: number }) {
        await this.exigirSuperadmin(userId);

        const name = validarNombre(dto.name);
        const dias = validarDias(dto.expiresInDays, MAX_DIAS_PLATAFORMA, true)!;
        const permisos = permisosParaClavePlataforma(dto.permissions);

        const activas = await this.keys.count({ where: { kind: 'platform', revokedAt: IsNull() } });
        if (activas >= MAX_CLAVES_PLATAFORMA_ACTIVAS) {
            throw new BadRequestException(`Puede haber hasta ${MAX_CLAVES_PLATAFORMA_ACTIVAS} claves de plataforma activas. Revoca alguna antes de crear otra.`);
        }

        const clave = PREFIJO_PLATAFORMA + randomBytes(32).toString('base64url');
        const fila = await this.keys.save(this.keys.create({
            kind: 'platform',
            store: null,
            createdBy: { id: userId } as any,
            name,
            keyHash: hashDeClave(clave),
            prefix: clave.slice(0, 12),
            permissions: permisos,
            expiresAt: new Date(Date.now() + dias * 24 * 3600 * 1000),
        }));
        this.logger.warn(`Clave de plataforma «${name}» creada por el superadmin ${userId} (${permisos.join(', ')}).`);
        return { ...this.presentar(fila), key: clave, warning: 'Guarda esta clave ahora: no se vuelve a mostrar.' };
    }

    /**
     * Valida una clave de plataforma. Cada llamada comprueba de nuevo que quien la creó SIGUE siendo superadmin y está activo:
     * si lo bajan de rol o lo desactivan, la clave deja de servir en la siguiente llamada.
     */
    async autenticarPlataforma(clave: string | undefined): Promise<AccesoPlataforma> {
        const mala = new UnauthorizedException('Clave inválida, caducada o revocada.');
        if (!clave || !clave.startsWith(PREFIJO_PLATAFORMA) || clave.length > 200) throw mala;

        const fila = await this.keys.findOne({
            where: { keyHash: hashDeClave(clave) },
            relations: { createdBy: true },
            select: { id: true, name: true, kind: true, permissions: true, expiresAt: true, revokedAt: true, lastUsedAt: true, createdBy: { id: true } },
        });
        if (!fila || fila.kind !== 'platform' || fila.revokedAt) throw mala;
        if (!fila.expiresAt || fila.expiresAt.getTime() <= Date.now()) throw mala;

        const creador = await this.users.findOne({ where: { id: fila.createdBy.id }, select: { id: true, role: true, isActive: true } });
        if (!creador || creador.role !== UserRole.ADMIN || creador.isActive === false) throw mala;

        const permissions = PERMISOS_PLATAFORMA.filter((p) => fila.permissions.includes(p));
        if (!permissions.length) throw new ForbiddenException('Esta clave no tiene permisos.');

        this.anotarUso(fila);
        return { keyId: fila.id, keyName: fila.name, userId: creador.id, permissions };
    }

    // ── Vista de superadmin: todas las claves ────────────────────

    /** Todas las claves de todas las tiendas y de plataforma, con su tienda y su creador. Solo superadmin. Nunca la clave ni su hash. */
    async listarTodas(adminId: string, filtro: FiltroDeClaves = {}) {
        await this.exigirSuperadmin(adminId);
        if (filtro.kind && !['store', 'platform'].includes(filtro.kind)) throw new BadRequestException('El tipo debe ser store o platform.');
        if (filtro.estado && !['activa', 'revocada', 'caducada'].includes(filtro.estado)) throw new BadRequestException('El estado debe ser activa, revocada o caducada.');

        const qb = this.keys.createQueryBuilder('k')
            .leftJoin('k.store', 's').addSelect(['s.id', 's.name'])
            .leftJoin('k.createdBy', 'u').addSelect(['u.id', 'u.email', 'u.name', 'u.lastName'])
            .orderBy('k.createdAt', 'DESC');
        if (filtro.kind) qb.andWhere('k.kind = :kind', { kind: filtro.kind });
        if (filtro.storeId) qb.andWhere('s.id = :storeId', { storeId: filtro.storeId });
        if (filtro.estado === 'revocada') qb.andWhere('k."revokedAt" IS NOT NULL');
        if (filtro.estado === 'caducada') qb.andWhere('k."revokedAt" IS NULL AND k."expiresAt" IS NOT NULL AND k."expiresAt" <= now()');
        if (filtro.estado === 'activa') qb.andWhere('k."revokedAt" IS NULL AND (k."expiresAt" IS NULL OR k."expiresAt" > now())');

        const filas = await qb.getMany();
        return filas.map((f) => ({
            ...this.presentar(f),
            estado: estadoDe(f),
            store: f.store ? { id: f.store.id, name: f.store.name } : null,
            createdBy: f.createdBy ? { id: f.createdBy.id, email: f.createdBy.email, name: `${f.createdBy.name ?? ''} ${f.createdBy.lastName ?? ''}`.trim() } : null,
        }));
    }

    /** Revoca cualquier clave (de tienda o de plataforma). Solo superadmin; queda anotado quién lo hizo. */
    async revocarComoSuperadmin(adminId: string, id: string) {
        await this.exigirSuperadmin(adminId);
        const fila = await this.keys.findOne({ where: { id }, relations: { createdBy: true, store: true }, select: { id: true, name: true, kind: true, revokedAt: true, createdBy: { id: true }, store: { id: true } } });
        if (!fila) throw new NotFoundException('Clave no encontrada.');
        if (!fila.revokedAt) {
            await this.keys.update({ id: fila.id }, { revokedAt: new Date() });
            this.logger.warn(`Clave «${fila.name}» (${fila.kind}) revocada por el superadmin ${adminId}. Creada por ${fila.createdBy?.id}${fila.store ? `, tienda ${fila.store.id}` : ''}.`);
        }
        return { id: fila.id, revoked: true };
    }

    // ── Comunes ──────────────────────────────────────────────────

    /** Anotar el uso como mucho una vez por minuto, sin esperar ni poder hacer fallar la llamada. */
    private anotarUso(fila: { id: string; lastUsedAt: Date | null }) {
        if (!fila.lastUsedAt || Date.now() - fila.lastUsedAt.getTime() > UN_MINUTO) {
            void this.keys.update({ id: fila.id }, { lastUsedAt: new Date() }).catch(() => undefined);
        }
    }

    private presentar(f: StoreApiKey) {
        return {
            id: f.id,
            kind: f.kind,
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
