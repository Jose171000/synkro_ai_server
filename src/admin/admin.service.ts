import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { MarketplaceOrder } from '../sync/entities/marketplace-order.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateAccessDto } from './dto/update-access.dto';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/user-role';
import { Product } from '../products/entities/product.entity';
import { ListingLink } from '../sync/entities/listing-link.entity';
import { MarketplaceConnection } from '../sync/entities/marketplace-connection.entity';
import { ClientProfile } from './entities/client-profile.entity';
import { Payment } from './entities/payment.entity';
import { UpdateClientProfileDto } from './dto/update-client-profile.dto';
import { CreatePaymentDto } from './dto/create-payment.dto';

@Injectable()
export class AdminService implements OnModuleInit {
    constructor(
        @InjectRepository(User) private readonly userRepository: Repository<User>,
        @InjectRepository(Product) private readonly productRepository: Repository<Product>,
        @InjectRepository(ListingLink) private readonly listingRepository: Repository<ListingLink>,
        @InjectRepository(MarketplaceConnection) private readonly connectionRepository: Repository<MarketplaceConnection>,
        @InjectRepository(ClientProfile) private readonly profileRepository: Repository<ClientProfile>,
        @InjectRepository(Payment) private readonly paymentRepository: Repository<Payment>,
        private readonly dataSource: DataSource,
    ) { }

    /**
     * Promotes the emails listed in ADMIN_EMAILS (comma-separated) to the
     * admin role on boot, so the first superadmin doesn't need manual SQL.
     */
    async onModuleInit() {
        const raw = process.env.ADMIN_EMAILS || '';
        const emails = raw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
        for (const email of emails) {
            const user = await this.userRepository.findOne({ where: { email } });
            if (user && user.role !== UserRole.ADMIN) {
                user.role = UserRole.ADMIN;
                await this.userRepository.save(user);
                console.log(`[Admin] ${email} promovido a admin (ADMIN_EMAILS)`);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Clientes
    // ─────────────────────────────────────────────────────────────

    async getClients() {
        const users = await this.userRepository.find({ order: { createdAt: 'DESC' } });
        const profiles = await this.profileRepository.find({ relations: { user: true } });
        const profileByUser = new Map(profiles.map(p => [p.user.id, p]));

        const result = [] as any[];
        for (const user of users) {
            const [productCount, listingCount, connections, paymentsAgg] = await Promise.all([
                this.productRepository.count({ where: { owner: { id: user.id } } }),
                this.listingRepository.count({ where: { product: { owner: { id: user.id } }, syncStatus: 'published' } }),
                this.connectionRepository.find({ where: { owner: { id: user.id } } }),
                this.paymentRepository
                    .createQueryBuilder('p')
                    .select('COALESCE(SUM(p.amount), 0)', 'total')
                    .addSelect('MAX("p"."paidAt")', 'lastpaidat')
                    .where('"p"."clientId" = :id', { id: user.id })
                    .getRawOne(),
            ]);

            const profile = profileByUser.get(user.id);
            const { password, ...safeUser } = user;
            // allowedSections viaja como array para que la UI marque las casillas

            result.push({
                ...safeUser,
                profile: profile
                    ? { ...profile, user: undefined }
                    : null,
                stats: {
                    products: productCount,
                    publishedListings: listingCount,
                    connectedMarketplaces: connections.map(c => c.marketplace),
                    totalPaid: Number(paymentsAgg?.total || 0),
                    lastPaymentAt: paymentsAgg?.lastpaidat || null,
                },
            });
        }
        return result;
    }

    /**
     * Crea una cuenta desde el panel: el superadmin define la contraseña
     * inicial y qué secciones verá el usuario.
     */
    async createClient(dto: CreateClientDto) {
        const email = dto.email.trim().toLowerCase();
        const existing = await this.userRepository.findOne({ where: { email } });
        if (existing) {
            throw new ConflictException(`Ya existe una cuenta con el correo ${email}.`);
        }

        const user = this.userRepository.create({
            name: dto.name,
            lastName: dto.lastName,
            email,
            password: await bcrypt.hash(dto.password, 10),
            nameCompany: dto.nameCompany,
            cellPhone: dto.cellPhone,
            role: dto.role === 'contador' ? UserRole.ACCOUNTANT : UserRole.USER,
            allowedSections: dto.allowedSections?.length ? dto.allowedSections : null,
        });
        const saved = await this.userRepository.save(user);

        // El contador es personal interno, no un cliente: sin perfil comercial
        if (dto.role === 'contador') {
            const { password, ...safeStaff } = saved;
            return safeStaff;
        }

        // Perfil comercial inicial para que aparezca completo en la tabla
        await this.profileRepository.save(
            this.profileRepository.create({
                user: { id: saved.id } as any,
                businessName: dto.nameCompany,
                contactName: `${dto.name} ${dto.lastName}`.trim(),
                contactPhone: dto.cellPhone,
                clientType: dto.clientType || 'saas',
                status: 'activo',
            }),
        );

        const { password, ...safe } = saved;
        return safe;
    }

    /** Cambia las secciones visibles y el estado de la cuenta. */
    async updateAccess(userId: string, dto: UpdateAccessDto) {
        const user = await this.userRepository.findOne({ where: { id: userId } });
        if (!user) throw new NotFoundException('Cliente no encontrado');

        if (dto.allowedSections !== undefined) {
            user.allowedSections = dto.allowedSections.length ? dto.allowedSections : null;
        }
        if (dto.isActive !== undefined) {
            user.isActive = dto.isActive;
        }

        const saved = await this.userRepository.save(user);
        const { password, ...safe } = saved;
        return safe;
    }

    /**
     * Asigna una contraseña nueva a un cliente. Pensado para cuando la
     * persona pierde el acceso y no puede usar el correo de recuperación.
     * Se cierran sus sesiones abiertas para que el cambio sea efectivo.
     */
    async resetClientPassword(userId: string, newPassword?: string) {
        const user = await this.userRepository.findOne({ where: { id: userId } });
        if (!user) throw new NotFoundException('Cliente no encontrado');

        const password = newPassword?.trim() || this.generatePassword();
        if (password.length < 8) {
            throw new BadRequestException('La contraseña debe tener al menos 8 caracteres.');
        }

        user.password = await bcrypt.hash(password, 10);
        await this.userRepository.save(user);

        // Invalida sesiones activas: si alguien más la tenía, queda fuera
        await this.dataSource
            .getRepository(RefreshToken)
            .delete({ user: { id: userId } });

        return {
            message: `Contraseña actualizada para ${user.email}.`,
            // Se devuelve para que el admin pueda copiarla y enviarla
            password,
        };
    }

    private generatePassword(): string {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
        let out = '';
        for (let i = 0; i < 10; i++) {
            out += chars[Math.floor(Math.random() * chars.length)];
        }
        return `${out}!`;
    }

    /**
     * Elimina una cuenta y todo lo que cuelga de ella. Va en una
     * transacción: o se borra todo, o no se borra nada.
     */
    async deleteClient(userId: string, requesterId: string) {
        const user = await this.userRepository.findOne({ where: { id: userId } });
        if (!user) throw new NotFoundException('Cliente no encontrado');

        if (userId === requesterId) {
            throw new BadRequestException('No puedes eliminar tu propia cuenta de administrador.');
        }
        if (user.role === UserRole.ADMIN) {
            const admins = await this.userRepository.count({ where: { role: UserRole.ADMIN } });
            if (admins <= 1) {
                throw new BadRequestException('No puedes eliminar al único administrador del sistema.');
            }
        }

        await this.dataSource.transaction(async (manager) => {
            // Primero lo que referencia al usuario sin borrado en cascada
            await manager.delete(Payment, { client: { id: userId } });
            await manager.delete(MarketplaceOrder, { owner: { id: userId } });
            await manager.delete(MarketplaceConnection, { owner: { id: userId } });
            await manager.delete(ClientProfile, { user: { id: userId } });
            // Los productos arrastran sus imágenes y publicaciones en cascada
            await manager.delete(Product, { owner: { id: userId } });
            // El usuario arrastra tokens de sesión y de recuperación
            await manager.delete(User, { id: userId });
        });

        return { message: `Cuenta de ${user.email} eliminada junto con todos sus datos.` };
    }

    async getClientDetail(userId: string) {
        const user = await this.userRepository.findOne({ where: { id: userId } });
        if (!user) throw new NotFoundException('Cliente no encontrado');

        const profile = await this.profileRepository.findOne({ where: { user: { id: userId } } });
        const payments = await this.paymentRepository.find({
            where: { client: { id: userId } },
            order: { paidAt: 'DESC' },
        });

        const { password, ...safeUser } = user;
        return { ...safeUser, profile, payments };
    }

    async updateClientProfile(userId: string, dto: UpdateClientProfileDto) {
        const user = await this.userRepository.findOne({ where: { id: userId } });
        if (!user) throw new NotFoundException('Cliente no encontrado');

        let profile = await this.profileRepository.findOne({ where: { user: { id: userId } } });
        if (!profile) {
            profile = this.profileRepository.create({ user: { id: userId } as any });
        }
        Object.assign(profile, dto);
        return this.profileRepository.save(profile);
    }

    // ─────────────────────────────────────────────────────────────
    // Pagos
    // ─────────────────────────────────────────────────────────────

    async addPayment(userId: string, dto: CreatePaymentDto) {
        const user = await this.userRepository.findOne({ where: { id: userId } });
        if (!user) throw new NotFoundException('Cliente no encontrado');

        const payment = this.paymentRepository.create({
            ...dto,
            currency: dto.currency || 'PEN',
            client: { id: userId } as any,
        });
        return this.paymentRepository.save(payment);
    }

    async removePayment(paymentId: string) {
        const payment = await this.paymentRepository.findOne({ where: { id: paymentId } });
        if (!payment) throw new NotFoundException('Pago no encontrado');
        await this.paymentRepository.remove(payment);
        return { message: 'Pago eliminado' };
    }

    // ─────────────────────────────────────────────────────────────
    // Finanzas
    // ─────────────────────────────────────────────────────────────

    async getFinanceSummary() {
        const now = new Date();
        const startOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

        const [totalRow, monthRow] = await Promise.all([
            this.paymentRepository.createQueryBuilder('p')
                .select('COALESCE(SUM(p.amount),0)', 'total')
                .getRawOne(),
            this.paymentRepository.createQueryBuilder('p')
                .select('COALESCE(SUM(p.amount),0)', 'total')
                .where('"p"."paidAt" >= :from', { from: startOfMonth })
                .getRawOne(),
        ]);

        // MRR: por cada cliente, su último pago recurrente mensualizado
        const recurring = await this.paymentRepository.createQueryBuilder('p')
            .distinctOn(['"p"."clientId"'])
            .where(`"p"."type" = 'recurrente'`)
            .orderBy('"p"."clientId"')
            .addOrderBy('"p"."paidAt"', 'DESC')
            .getMany();

        const mrr = recurring.reduce((sum, p) => {
            const amount = Number(p.amount);
            if (p.frequency === 'anual') return sum + amount / 12;
            if (p.frequency === 'trimestral') return sum + amount / 3;
            return sum + amount; // mensual o sin frecuencia
        }, 0);

        // Ingresos por mes — últimos 12 meses
        const monthly = await this.paymentRepository.createQueryBuilder('p')
            .select(`TO_CHAR("p"."paidAt"::date, 'YYYY-MM')`, 'month')
            .addSelect('SUM(p.amount)', 'total')
            .where(`"p"."paidAt" >= (CURRENT_DATE - INTERVAL '12 months')`)
            .groupBy('month')
            .orderBy('month', 'ASC')
            .getRawMany();

        const activeClients = await this.profileRepository.count({ where: { status: 'activo' } });
        const totalClients = await this.userRepository.count();

        return {
            totalCollected: Number(totalRow?.total || 0),
            monthCollected: Number(monthRow?.total || 0),
            mrr: Math.round(mrr * 100) / 100,
            activeClients,
            totalClients,
            monthlyIncome: monthly.map(m => ({ month: m.month, total: Number(m.total) })),
        };
    }
}
