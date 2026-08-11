import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
