import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { StoreRole } from './entities/store-member.entity';
import { NO_STORE_ACCESS, SIN_PERMISO, StoresService } from './stores.service';
import { Permiso } from './permissions';

export const STORE_ROLE_KEY = 'store_role';
export const STORE_PERMISSION_KEY = 'store_permission';

/**
 * Exige que la persona tenga este permiso en la tienda activa. Es lo que se usa en todo lo que no sea gestionar el equipo.
 * Ver docs/roles-de-tienda.md.
 */
export const RequirePermission = (permiso: Permiso) => SetMetadata(STORE_PERMISSION_KEY, permiso);

/**
 * Exige estar en la tienda activa con al menos este rol (por defecto, lector). Solo para la gestión del equipo, que es
 * siempre del dueño; el resto de las rutas usan `RequirePermission`.
 */
export const RequireStoreRole = (role: StoreRole = 'viewer') => SetMetadata(STORE_ROLE_KEY, role);

/**
 * Protege las rutas que dependen de una tienda.
 *
 * La tienda activa llega en la cabecera `X-Store-Id` (o en `:storeId` de la
 * ruta). Si no llega ninguna (un cliente anterior a las tiendas) se usa la
 * tienda por defecto del usuario. NUNCA se confía en ella: se comprueba contra la tabla de miembros en
 * cada petición, así que quitarle el acceso a alguien tiene efecto inmediato.
 * Va después de JwtAuthGuard. Deja `request.store` con { storeId, role }.
 */
@Injectable()
export class StoreAccessGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly stores: StoresService,
    ) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const objetivos = [context.getHandler(), context.getClass()];
        const permiso = this.reflector.getAllAndOverride<Permiso | undefined>(STORE_PERMISSION_KEY, objetivos);
        const minimum = this.reflector.getAllAndOverride<StoreRole>(STORE_ROLE_KEY, objetivos) ?? 'viewer';

        const request = context.switchToHttp().getRequest();
        const userId = request.user?.id;
        const header = request.headers?.['x-store-id'];
        let storeId = request.params?.storeId ?? (Array.isArray(header) ? header[0] : header);

        if (!userId) throw new ForbiddenException(NO_STORE_ACCESS);

        if (!storeId) {
            await this.stores.ensureDefaultStore(userId);
            storeId = (await this.stores.defaultStoreId(userId)) ?? undefined;
        }
        if (!storeId) throw new ForbiddenException(NO_STORE_ACCESS);

        const acceso = await this.stores.requireAccess(userId, String(storeId), minimum);
        if (permiso && !acceso.permissions.includes(permiso)) throw new ForbiddenException(SIN_PERMISO);
        request.store = acceso;
        return true;
    }
}
