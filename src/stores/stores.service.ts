import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { MailService } from '../mail/mail.service';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/user-role';
import { ListingLink } from '../sync/entities/listing-link.entity';
import { Store } from './entities/store.entity';
import { StoreInvitation } from './entities/store-invitation.entity';
import { STORE_ROLE_RANK, StoreMember, StoreRole } from './entities/store-member.entity';

/** Las invitaciones caducan: un enlace olvidado en un correo no debe valer para siempre. */
const INVITATION_DAYS = 7;

export const NO_STORE_ACCESS = 'No tienes acceso a esta tienda.';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Acceso de un usuario a una tienda ya comprobado. */
export interface StoreAccess {
    storeId: string;
    role: StoreRole;
}

@Injectable()
export class StoresService {
    constructor(
        @InjectRepository(Store) private readonly stores: Repository<Store>,
        @InjectRepository(StoreMember) private readonly members: Repository<StoreMember>,
        @InjectRepository(StoreInvitation) private readonly invitations: Repository<StoreInvitation>,
        @InjectRepository(User) private readonly users: Repository<User>,
        @InjectRepository(ListingLink) private readonly links: Repository<ListingLink>,
        private readonly mail: MailService,
    ) { }

    // ── Acceso ───────────────────────────────────────────────────

    /**
     * Comprueba que el usuario pertenece a la tienda y devuelve su rol, o
     * lanza «No tienes acceso». Es la ÚNICA puerta: todo lo que dependa de una
     * tienda debe pasar por aquí.
     *
     * El administrador de la agencia entra a cualquier tienda como dueño.
     */
    async requireAccess(userId: string, storeId: string, minimum: StoreRole = 'viewer'): Promise<StoreAccess> {
        if (!/^[0-9a-f-]{36}$/i.test(storeId ?? '')) throw new ForbiddenException(NO_STORE_ACCESS);

        const user = await this.users.findOne({ where: { id: userId }, select: { id: true, role: true } });
        if (!user) throw new ForbiddenException(NO_STORE_ACCESS);

        let role: StoreRole | null = null;
        if (user.role === UserRole.ADMIN) {
            const exists = await this.stores.exist({ where: { id: storeId } });
            if (exists) role = 'owner';
        } else {
            const member = await this.members.findOne({ where: { store: { id: storeId }, user: { id: userId } } });
            role = member?.role ?? null;
        }

        // Misma respuesta si la tienda no existe o si no es suya: no se revela cuál.
        if (!role) throw new ForbiddenException(NO_STORE_ACCESS);
        if (STORE_ROLE_RANK[role] < STORE_ROLE_RANK[minimum]) {
            throw new ForbiddenException('Tu rol en esta tienda no permite esta acción.');
        }
        return { storeId, role };
    }

    // ── Tiendas ──────────────────────────────────────────────────

    /**
     * Solo quien se registró por su cuenta puede crear tiendas. Las cuentas
     * nacidas de una invitación entran a las tiendas de otros pero no tienen
     * un espacio propio. El administrador de la agencia puede siempre.
     */
    async canCreateStores(userId: string): Promise<boolean> {
        const user = await this.users.findOne({
            where: { id: userId },
            select: { id: true, role: true, createdFromInvitation: true },
        });
        if (!user) return false;
        return user.role === UserRole.ADMIN || !user.createdFromInvitation;
    }

    /**
     * Marca la cuenta como «nacida de una invitación» si, al registrarse, su
     * correo tiene una invitación vigente. Se llama justo después de crear la cuenta.
     */
    async flagIfInvited(userId: string, email: string): Promise<boolean> {
        const pendiente = await this.invitations.exist({
            where: { email: (email ?? '').trim().toLowerCase(), acceptedAt: IsNull(), expiresAt: MoreThan(new Date()) },
        });
        if (pendiente) await this.users.update({ id: userId }, { createdFromInvitation: true });
        return pendiente;
    }

    async create(userId: string, name: string) {
        if (!(await this.canCreateStores(userId))) {
            throw new ForbiddenException(
                'Tu cuenta se creó por invitación, así que no puede crear tiendas propias. Pídele al dueño de tu tienda lo que necesites.',
            );
        }
        return this.createUnchecked(userId, name);
    }

    private async createUnchecked(userId: string, name: string) {
        const clean = (name ?? '').trim();
        if (clean.length < 2) throw new BadRequestException('Ponle un nombre a la tienda (mínimo 2 caracteres).');

        const store = await this.stores.save(this.stores.create({ name: clean.slice(0, 120), owner: { id: userId } as User }));
        await this.members.save(this.members.create({ store, user: { id: userId } as User, role: 'owner' }));
        return { id: store.id, name: store.name, role: 'owner' as StoreRole };
    }

    /**
     * Quien se registró por su cuenta y todavía no tiene ninguna tienda recibe
     * la suya (con el nombre de su empresa, o el suyo). Las cuentas por
     * invitación no reciben una: entran a las de otros.
     */
    async ensureDefaultStore(userId: string): Promise<void> {
        const user = await this.users.findOne({
            where: { id: userId },
            select: { id: true, name: true, lastName: true, nameCompany: true, createdFromInvitation: true },
        });
        if (!user || user.createdFromInvitation) return;
        if (await this.members.exist({ where: { user: { id: userId } } })) return;

        const nombre = (user.nameCompany || `${user.name ?? ''} ${user.lastName ?? ''}`).trim() || 'Mi tienda';
        await this.createUnchecked(userId, nombre);
    }

    /** La tienda que se usa cuando una petición no dice cuál: la más antigua de las suyas. */
    async defaultStoreId(userId: string): Promise<string | null> {
        const own = await this.members.findOne({
            where: { user: { id: userId }, role: 'owner' },
            relations: { store: true },
            order: { createdAt: 'ASC' },
        });
        if (own) return own.store.id;
        const any = await this.members.findOne({
            where: { user: { id: userId } },
            relations: { store: true },
            order: { createdAt: 'ASC' },
        });
        return any?.store.id ?? null;
    }

    /** Las tiendas a las que el usuario tiene acceso (el desplegable del selector). */
    async listMine(userId: string) {
        await this.ensureDefaultStore(userId);
        const rows = await this.members.find({
            where: { user: { id: userId } },
            relations: { store: true },
            order: { createdAt: 'ASC' },
        });
        return {
            stores: rows.map(m => ({
                id: m.store.id,
                name: m.store.name,
                role: m.role,
                publicEnabled: m.store.publicEnabled,
            })),
            canCreateStores: await this.canCreateStores(userId),
        };
    }

    // ── Ajustes de la tienda ─────────────────────────────────────

    async getReviewMode(storeId: string): Promise<boolean> {
        const store = await this.stores.findOne({ where: { id: storeId }, select: { id: true, syncReviewMode: true } });
        // Ante la duda se revisa: es el lado seguro.
        return store?.syncReviewMode ?? true;
    }

    async setReviewMode(storeId: string, enabled: boolean) {
        await this.stores.update({ id: storeId }, { syncReviewMode: enabled });
        return { reviewMode: enabled };
    }

    async rename(userId: string, storeId: string, name: string) {
        await this.requireAccess(userId, storeId, 'owner');
        const clean = (name ?? '').trim();
        if (clean.length < 2) throw new BadRequestException('Ponle un nombre a la tienda (mínimo 2 caracteres).');
        await this.stores.update({ id: storeId }, { name: clean.slice(0, 120) });
        return { id: storeId, name: clean.slice(0, 120) };
    }

    // ── Miembros ─────────────────────────────────────────────────

    async listMembers(userId: string, storeId: string) {
        await this.requireAccess(userId, storeId, 'viewer');
        const rows = await this.members.find({ where: { store: { id: storeId } }, relations: { user: true }, order: { createdAt: 'ASC' } });
        return rows.map(m => ({
            userId: m.user.id,
            name: `${m.user.name} ${m.user.lastName}`.trim(),
            email: m.user.email,
            role: m.role,
        }));
    }

    async changeRole(userId: string, storeId: string, targetUserId: string, role: Exclude<StoreRole, 'owner'>) {
        await this.requireAccess(userId, storeId, 'owner');
        const target = await this.members.findOne({ where: { store: { id: storeId }, user: { id: targetUserId } } });
        if (!target) throw new NotFoundException('Esa persona no es miembro de la tienda.');
        if (target.role === 'owner') throw new BadRequestException('El rol del dueño no se puede cambiar.');
        target.role = role;
        await this.members.save(target);
        return { userId: targetUserId, role };
    }

    async removeMember(userId: string, storeId: string, targetUserId: string) {
        await this.requireAccess(userId, storeId, 'owner');
        const target = await this.members.findOne({ where: { store: { id: storeId }, user: { id: targetUserId } } });
        if (!target) throw new NotFoundException('Esa persona no es miembro de la tienda.');
        if (target.role === 'owner') throw new BadRequestException('El dueño no se puede quitar de su propia tienda.');
        await this.members.remove(target);
        return { removed: true };
    }

    // ── Invitaciones ─────────────────────────────────────────────

    async invite(userId: string, storeId: string, email: string, role: Exclude<StoreRole, 'owner'>) {
        await this.requireAccess(userId, storeId, 'owner');
        const clean = (email ?? '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new BadRequestException('Escribe un correo válido.');

        const already = await this.members.findOne({ where: { store: { id: storeId }, user: { email: clean } } });
        if (already) throw new BadRequestException('Esa persona ya tiene acceso a la tienda.');

        // Una sola invitación vigente por correo y tienda: la nueva anula la anterior.
        await this.invitations.delete({ store: { id: storeId }, email: clean, acceptedAt: IsNull() });

        const token = randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + INVITATION_DAYS * 24 * 3600 * 1000);
        await this.invitations.save(this.invitations.create({
            store: { id: storeId } as Store,
            email: clean,
            role,
            tokenHash: sha256(token),
            expiresAt,
            acceptedAt: null,
            invitedBy: { id: userId } as User,
        }));

        const [store, inviter] = await Promise.all([
            this.stores.findOne({ where: { id: storeId } }),
            this.users.findOne({ where: { id: userId }, select: { id: true, name: true, lastName: true } }),
        ]);
        // Si el correo falla, la invitación sigue existiendo; se avisa al dueño.
        let emailSent = true;
        try {
            await this.mail.sendStoreInvitation(clean, {
                storeName: store?.name ?? 'una tienda',
                inviterName: `${inviter?.name ?? ''} ${inviter?.lastName ?? ''}`.trim(),
                role,
                token,
                days: INVITATION_DAYS,
            });
        } catch (error: any) {
            // Sin esto el motivo (remitente no validado, clave inválida…) no se vería en ningún sitio.
            const detalle = error?.response?.data ? JSON.stringify(error.response.data) : error?.message;
            console.warn(`[Stores] No se pudo enviar la invitación a ${clean}: ${detalle}`);
            emailSent = false;
        }
        return { email: clean, role, expiresAt, emailSent };
    }

    async listInvitations(userId: string, storeId: string) {
        await this.requireAccess(userId, storeId, 'owner');
        const rows = await this.invitations.find({ where: { store: { id: storeId }, acceptedAt: IsNull() }, order: { createdAt: 'DESC' } });
        return rows.map(i => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt, expired: i.expiresAt < new Date() }));
    }

    async revokeInvitation(userId: string, storeId: string, invitationId: string) {
        await this.requireAccess(userId, storeId, 'owner');
        const result = await this.invitations.delete({ id: invitationId, store: { id: storeId } });
        if (!result.affected) throw new NotFoundException('Invitación no encontrada.');
        return { revoked: true };
    }

    /**
     * Acepta una invitación. Solo sirve para el correo al que se envió: si el
     * enlace se reenvía a otra persona, esa persona no entra.
     */
    async acceptInvitation(userId: string, token: string) {
        const invitation = await this.invitations.findOne({
            where: { tokenHash: sha256(token ?? '') },
            relations: { store: true },
        });
        const user = await this.users.findOne({ where: { id: userId }, select: { id: true, email: true } });

        if (!invitation || invitation.acceptedAt || invitation.expiresAt < new Date()) {
            throw new BadRequestException('La invitación no es válida o ya caducó. Pide una nueva al dueño de la tienda.');
        }
        if (!user || user.email.toLowerCase() !== invitation.email) {
            throw new ForbiddenException(`Esta invitación es para ${invitation.email}. Inicia sesión con ese correo.`);
        }

        // La transición «sin aceptar → aceptada» es atómica: dos clics no crean dos membresías.
        const claimed = await this.invitations.update({ id: invitation.id, acceptedAt: IsNull() }, { acceptedAt: new Date() });
        if (!claimed.affected) throw new BadRequestException('La invitación ya fue usada.');

        const exists = await this.members.exist({ where: { store: { id: invitation.store.id }, user: { id: userId } } });
        if (!exists) {
            await this.members.save(this.members.create({ store: invitation.store, user: { id: userId } as User, role: invitation.role }));
        }
        return { storeId: invitation.store.id, name: invitation.store.name, role: invitation.role };
    }

    // ── Enlace público ───────────────────────────────────────────

    /** Activa o apaga el enlace público. El código se crea la primera vez que se activa. */
    async setPublicLink(userId: string, storeId: string, enabled: boolean, regenerate = false) {
        await this.requireAccess(userId, storeId, 'owner');
        const store = await this.stores.findOne({ where: { id: storeId } });
        if (!store) throw new NotFoundException('Tienda no encontrada.');

        if (enabled && (!store.publicToken || regenerate)) {
            store.publicToken = randomBytes(24).toString('base64url');
        }
        store.publicEnabled = enabled;
        await this.stores.save(store);

        return {
            publicEnabled: store.publicEnabled,
            url: store.publicEnabled && store.publicToken
                ? `${(process.env.FRONTEND_URL || '').split(',')[0].replace(/\/+$/, '')}/t/${store.publicToken}`
                : null,
        };
    }

    /**
     * Información general de una tienda, SIN iniciar sesión.
     *
     * Solo cifras agregadas: nada de precios, stock, pedidos ni clientes. Si el
     * enlace no existe o está apagado se responde igual (404), para que no se
     * pueda saber si un código perteneció a una tienda.
     *
     * Nota: mientras los datos sigan colgando del usuario y no de la tienda,
     * el resumen sale de las publicaciones del dueño.
     */
    async publicSummary(token: string) {
        if (!token || token.length < 20) throw new NotFoundException('Enlace no disponible.');
        const store = await this.stores.findOne({ where: { publicToken: token, publicEnabled: true }, relations: { owner: true } });
        if (!store) throw new NotFoundException('Enlace no disponible.');

        const links = await this.links.find({
            where: { product: { owner: { id: store.owner.id } } },
            select: { id: true, marketplace: true, syncStatus: true, qualityScore: true },
        });

        const porEstado: Record<string, number> = {};
        const canales = new Set<string>();
        let sumaNotas = 0;
        let conNota = 0;
        for (const l of links) {
            porEstado[l.syncStatus] = (porEstado[l.syncStatus] ?? 0) + 1;
            canales.add(l.marketplace);
            if (l.qualityScore != null) { sumaNotas += l.qualityScore; conNota++; }
        }

        return {
            name: store.name,
            channels: [...canales].sort(),
            publications: links.length,
            byStatus: porEstado,
            averageQuality: conNota ? Math.round(sumaNotas / conNota) : null,
        };
    }
}
