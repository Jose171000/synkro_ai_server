import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { StoreCustomRole } from './entities/store-custom-role.entity';
import { StoreInvitation } from './entities/store-invitation.entity';
import { StoreMember, StoreRole } from './entities/store-member.entity';
import {
    DEPENDENCIAS, DESCRIPCION_DE_PERMISOS, NOMBRE_DE_ROL_DE_FABRICA, NOMBRES_RESERVADOS, normalizarPermisos, Permiso, PERMISOS,
    PERMISOS_DE_FABRICA, rolDeFabricaIgualA,
} from './permissions';
import { StoresService } from './stores.service';

/** Cuántos roles personalizados puede tener una tienda: más que eso es casi seguro un error o un abuso. */
export const MAX_ROLES_POR_TIENDA = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lo que las pantallas necesitan para dibujar los permisos: no cambia de una tienda a otra. */
export function catalogoDePermisos() {
    return {
        permisos: PERMISOS.map((clave) => ({ clave, ...DESCRIPCION_DE_PERMISOS[clave], requiere: DEPENDENCIAS[clave] ?? [] })),
        fabrica: (['viewer', 'editor', 'owner'] as StoreRole[]).map((clave) => ({ clave, nombre: NOMBRE_DE_ROL_DE_FABRICA[clave], permisos: [...PERMISOS_DE_FABRICA[clave]] })),
        maximoDeRoles: MAX_ROLES_POR_TIENDA,
    };
}

/**
 * Roles personalizados de una tienda. Solo el dueño los gestiona (y no se puede delegar: un rol que pudiera crear roles
 * podría darse a sí mismo más permisos de los que tiene). Los permisos de cada rol se leen en cada petición, así que un
 * cambio vale desde la siguiente acción de las personas que lo tienen.
 */
@Injectable()
export class StoreRolesService {
    constructor(
        @InjectRepository(StoreCustomRole) private readonly roles: Repository<StoreCustomRole>,
        @InjectRepository(StoreMember) private readonly members: Repository<StoreMember>,
        @InjectRepository(StoreInvitation) private readonly invitations: Repository<StoreInvitation>,
        private readonly stores: StoresService,
    ) { }

    private async uso(roleId: string) {
        const [personas, invitaciones] = await Promise.all([
            this.members.count({ where: { customRole: { id: roleId } } }),
            this.invitations.count({ where: { customRole: { id: roleId }, acceptedAt: IsNull() } }),
        ]);
        return { personas, invitaciones };
    }

    private vista(r: StoreCustomRole, uso: { personas: number; invitaciones: number }) {
        return { id: r.id, name: r.name, permissions: normalizarPermisos(r.permissions).permisos, people: uso.personas, invitations: uso.invitaciones, createdAt: r.createdAt };
    }

    /** Los roles de la tienda: los de fábrica (fijos) y los personalizados con cuántas personas tiene cada uno. */
    async list(userId: string, storeId: string) {
        await this.stores.requireAccess(userId, storeId, 'owner');
        const filas = await this.roles.find({ where: { store: { id: storeId } }, order: { name: 'ASC' } });
        const personalizados = await Promise.all(filas.map(async (r) => this.vista(r, await this.uso(r.id))));
        return { ...catalogoDePermisos(), personalizados };
    }

    /** Valida nombre y permisos de un rol. Devuelve el nombre limpio y los permisos ya completados con sus dependencias. */
    private validar(nombre: unknown, permisosCrudos: unknown): { name: string; permisos: Permiso[]; agregados: Permiso[] } {
        const name = String(nombre ?? '').replace(/\s+/g, ' ').trim();
        if (name.length < 2) throw new BadRequestException('Ponle un nombre al rol (mínimo 2 letras).');
        if (name.length > 40) throw new BadRequestException('El nombre del rol puede tener hasta 40 letras.');
        if (/[<>@]/.test(name)) throw new BadRequestException('El nombre del rol no puede llevar los símbolos < > @.');
        const sinTildes = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        if (NOMBRES_RESERVADOS.some((n) => n.normalize('NFD').replace(/[̀-ͯ]/g, '') === sinTildes)) {
            throw new BadRequestException(`«${name}» es el nombre de un rol de fábrica. Elige otro nombre.`);
        }

        const { permisos, invalidos, agregados } = normalizarPermisos(permisosCrudos);
        if (invalidos.length) throw new BadRequestException(`Permisos que no existen: ${invalidos.join(', ')}.`);
        if (!permisos.length) throw new BadRequestException('Marca al menos un permiso.');
        // Un conjunto idéntico a uno de fábrica ES ese rol: no se guarda como personalizado.
        const fabrica = rolDeFabricaIgualA(permisos);
        if (fabrica) throw new BadRequestException(`Esos permisos son exactamente los del rol de fábrica «${NOMBRE_DE_ROL_DE_FABRICA[fabrica]}». Usa ese rol, o cambia algún permiso para crear uno personalizado.`);
        return { name, permisos, agregados };
    }

    private async nombreLibre(storeId: string, name: string, exceptoId?: string) {
        const existe = await this.roles.createQueryBuilder('r')
            .where('r."storeId" = :storeId', { storeId })
            .andWhere('lower(r.name) = lower(:name)', { name })
            .andWhere(exceptoId ? 'r.id <> :exceptoId' : '1=1', { exceptoId })
            .getCount();
        if (existe) throw new ConflictException(`Ya hay un rol llamado «${name}» en esta tienda.`);
    }

    async create(userId: string, storeId: string, nombre: unknown, permisosCrudos: unknown) {
        await this.stores.requireAccess(userId, storeId, 'owner');
        const { name, permisos, agregados } = this.validar(nombre, permisosCrudos);
        if ((await this.roles.count({ where: { store: { id: storeId } } })) >= MAX_ROLES_POR_TIENDA) {
            throw new BadRequestException(`Una tienda puede tener hasta ${MAX_ROLES_POR_TIENDA} roles personalizados. Borra alguno que ya no uses.`);
        }
        await this.nombreLibre(storeId, name);
        const creado = await this.roles.save(this.roles.create({ store: { id: storeId } as any, name, permissions: permisos }));
        return { ...this.vista(creado, { personas: 0, invitaciones: 0 }), addedAutomatically: agregados };
    }

    private async delaTienda(storeId: string, roleId: string): Promise<StoreCustomRole> {
        const rol = UUID.test(roleId ?? '') ? await this.roles.findOne({ where: { id: roleId, store: { id: storeId } } }) : null;
        if (!rol) throw new NotFoundException('Ese rol no existe en esta tienda.');
        return rol;
    }

    async update(userId: string, storeId: string, roleId: string, cambios: { name?: unknown; permissions?: unknown }) {
        await this.stores.requireAccess(userId, storeId, 'owner');
        const rol = await this.delaTienda(storeId, roleId);
        const { name, permisos, agregados } = this.validar(cambios.name ?? rol.name, cambios.permissions ?? rol.permissions);
        if (name.toLowerCase() !== rol.name.toLowerCase()) await this.nombreLibre(storeId, name, rol.id);
        rol.name = name;
        rol.permissions = permisos;
        const guardado = await this.roles.save(rol);
        return { ...this.vista(guardado, await this.uso(rol.id)), addedAutomatically: agregados };
    }

    async remove(userId: string, storeId: string, roleId: string) {
        await this.stores.requireAccess(userId, storeId, 'owner');
        const rol = await this.delaTienda(storeId, roleId);
        const { personas, invitaciones } = await this.uso(rol.id);
        if (personas || invitaciones) {
            const partes = [personas ? `${personas} ${personas === 1 ? 'persona' : 'personas'}` : '', invitaciones ? `${invitaciones} ${invitaciones === 1 ? 'invitación pendiente' : 'invitaciones pendientes'}` : ''].filter(Boolean);
            throw new ConflictException(`«${rol.name}» lo tienen ${partes.join(' y ')}. Cámbiales el rol (o anula la invitación) antes de borrarlo.`);
        }
        await this.roles.remove(rol);
        return { removed: true };
    }
}
