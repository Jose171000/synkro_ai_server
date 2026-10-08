import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { StoreRole } from './entities/store-member.entity';
import { NO_STORE_ACCESS, StoresService } from './stores.service';

export const STORE_ROLE_KEY = 'store_role';

/** Exige estar en la tienda activa con al menos este rol (por defecto, lector). */
export const RequireStoreRole = (role: StoreRole = 'viewer') => SetMetadata(STORE_ROLE_KEY, role);

/**
 * Protege las rutas que dependen de una tienda.
 *
 * La tienda activa llega en la cabecera `X-Store-Id` (o en `:storeId` de la
 * ruta). NUNCA se confía en ella: se comprueba contra la tabla de miembros en
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
        const minimum = this.reflector.getAllAndOverride<StoreRole>(STORE_ROLE_KEY, [
            context.getHandler(),
            context.getClass(),
        ]) ?? 'viewer';

        const request = context.switchToHttp().getRequest();
        const userId = request.user?.id;
        const header = request.headers?.['x-store-id'];
        const storeId = request.params?.storeId ?? (Array.isArray(header) ? header[0] : header);

        if (!userId || !storeId) throw new ForbiddenException(NO_STORE_ACCESS);

        request.store = await this.stores.requireAccess(userId, String(storeId), minimum);
        return true;
    }
}
