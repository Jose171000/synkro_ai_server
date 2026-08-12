import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { UserRole } from '../../users/user-role';
import { AppSection, canAccessSection } from '../app-sections';

export const SECTION_KEY = 'app_section';

/** Marca el controlador (o ruta) como perteneciente a una sección de la app. */
export const RequireSection = (section: AppSection) => SetMetadata(SECTION_KEY, section);

/**
 * Impide que un usuario use los endpoints de una sección que el superadmin
 * le restringió. Se consulta el usuario en cada petición para que quitarle
 * el acceso tenga efecto inmediato, sin esperar a que renueve su sesión.
 */
@Injectable()
export class SectionAccessGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        @InjectRepository(User) private readonly userRepository: Repository<User>,
    ) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const section = this.reflector.getAllAndOverride<AppSection>(SECTION_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (!section) return true;

        const request = context.switchToHttp().getRequest();
        const payload = request.user;
        if (!payload?.id) return true; // otras guards se encargan de la autenticación

        const user = await this.userRepository.findOne({
            where: { id: payload.id },
            select: { id: true, role: true, allowedSections: true },
        });
        if (!user) return true;

        // El administrador nunca queda fuera de una sección
        if (user.role === UserRole.ADMIN) return true;

        if (!canAccessSection(user.allowedSections, section)) {
            throw new ForbiddenException(
                'Tu cuenta no tiene acceso a esta sección. Contacta al administrador.',
            );
        }
        return true;
    }
}
