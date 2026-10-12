import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { ClientProfile } from './entities/client-profile.entity';
import { Store } from '../stores/entities/store.entity';
import { StoresService } from '../stores/stores.service';
import { MailService } from '../mail/mail.service';

export type EstadoDeSolicitud = 'pending' | 'rejected';

/**
 * Solicitudes de cuenta: quien se registra por su cuenta espera a que un
 * superadmin revise los datos de su empresa. Al aprobar se le crea su tienda
 * (con el nombre que puso) y recién entonces puede entrar; no puede crear más
 * tiendas, solo los superadmins.
 */
@Injectable()
export class SignupsService {
    private readonly logger = new Logger(SignupsService.name);

    constructor(
        @InjectRepository(User) private readonly users: Repository<User>,
        @InjectRepository(ClientProfile) private readonly profiles: Repository<ClientProfile>,
        @InjectRepository(Store) private readonly stores: Repository<Store>,
        private readonly storesService: StoresService,
        private readonly mail: MailService,
    ) { }

    /** Solicitudes con los datos que dejó la persona para revisarla: las pendientes, o las rechazadas. */
    async list(status: EstadoDeSolicitud = 'pending') {
        const [usuarios, pendientes, rechazadas] = await Promise.all([
            this.users.find({ where: { approvalStatus: status }, order: { createdAt: 'DESC' } }),
            this.users.count({ where: { approvalStatus: 'pending' } }),
            this.users.count({ where: { approvalStatus: 'rejected' } }),
        ]);
        const perfiles = usuarios.length
            ? await this.profiles.find({ where: usuarios.map(u => ({ user: { id: u.id } })) as any, relations: { user: true } })
            : [];
        const perfilDe = new Map(perfiles.map(p => [p.user?.id, p]));

        return {
            conteo: { pendientes, rechazadas },
            solicitudes: usuarios.map(u => ({
                id: u.id,
                nombre: `${u.name ?? ''} ${u.lastName ?? ''}`.trim(),
                email: u.email,
                tienda: u.nameCompany ?? null,
                razonSocial: perfilDe.get(u.id)?.businessName ?? null,
                ruc: perfilDe.get(u.id)?.ruc ?? null,
                web: u.url ?? null,
                telefono: u.cellPhone ?? null,
                pais: u.country ?? null,
                estado: u.approvalStatus,
                motivo: u.approvalNote ?? null,
                fecha: u.createdAt,
            })),
        };
    }

    private async buscar(userId: string): Promise<User> {
        const user = await this.users.findOne({ where: { id: userId } });
        if (!user) throw new NotFoundException('Solicitud no encontrada');
        return user;
    }

    /** Aprueba la cuenta y le crea su tienda con el nombre que indicó. */
    async approve(userId: string) {
        const user = await this.buscar(userId);
        if (user.approvalStatus === 'approved') throw new BadRequestException('Esa cuenta ya está aprobada.');

        await this.users.update(userId, { approvalStatus: 'approved', approvalNote: null, approvedAt: new Date() });

        // Su tienda: la crea el superadmin al aprobar. Si por algún motivo ya tiene una, no se duplica.
        let tienda: { id: string; name: string } | null = null;
        const yaTiene = await this.stores.findOne({ where: { owner: { id: userId } } });
        if (yaTiene) {
            tienda = { id: yaTiene.id, name: yaTiene.name };
        } else {
            const nombre = (user.nameCompany || `${user.name ?? ''} ${user.lastName ?? ''}`).trim() || 'Mi tienda';
            tienda = await this.storesService.createForOwner(userId, nombre);
        }

        this.mail.sendAccountApproved(user.email, user.name, tienda.name).catch(err =>
            this.logger.error(`No se pudo avisar a ${user.email} de su aprobación: ${err?.message}`),
        );
        return { message: `Cuenta de ${user.email} aprobada. Su tienda «${tienda.name}» está lista.`, storeId: tienda.id };
    }

    /** Rechaza la solicitud; la persona no puede entrar y se le avisa con el motivo, si lo hay. */
    async reject(userId: string, reason?: string | null) {
        const user = await this.buscar(userId);
        if (user.approvalStatus === 'approved') {
            throw new BadRequestException('Esa cuenta ya está aprobada: para quitarle el acceso, elimínala o desactívala.');
        }
        const motivo = (reason ?? '').trim().slice(0, 500) || null;
        await this.users.update(userId, { approvalStatus: 'rejected', approvalNote: motivo, approvedAt: null });

        this.mail.sendAccountRejected(user.email, user.name, motivo).catch(err =>
            this.logger.error(`No se pudo avisar a ${user.email} del rechazo: ${err?.message}`),
        );
        return { message: `Solicitud de ${user.email} rechazada.` };
    }
}
