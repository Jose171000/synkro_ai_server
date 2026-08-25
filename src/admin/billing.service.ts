import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MonthlyBilling } from './entities/monthly-billing.entity';
import { ClientProfile } from './entities/client-profile.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/user-role';
import { ReportsService } from '../reports/reports.service';
import { UpsertBillingDto, UpdateBillingStatusDto } from './dto/billing.dto';

@Injectable()
export class BillingService {
    constructor(
        @InjectRepository(MonthlyBilling) private readonly billingRepository: Repository<MonthlyBilling>,
        @InjectRepository(ClientProfile) private readonly profileRepository: Repository<ClientProfile>,
        @InjectRepository(User) private readonly userRepository: Repository<User>,
        private readonly reportsService: ReportsService,
    ) { }

    /** Redondeo a dos decimales sin sorpresas de coma flotante. */
    private round(value: number): number {
        return Math.round((value + Number.EPSILON) * 100) / 100;
    }

    private periodRange(period: string): { from: string; to: string } {
        const [year, month] = period.split('-').map(Number);
        const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        return {
            from: `${period}-01`,
            to: `${period}-${String(lastDay).padStart(2, '0')}`,
        };
    }

    /**
     * Todos los clientes del periodo, tengan o no liquidación cargada.
     * Así el contador ve de un vistazo a quién falta facturar.
     */
    async getPeriod(period: string) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
            throw new BadRequestException('El periodo debe tener el formato YYYY-MM.');
        }

        const [users, profiles, billings] = await Promise.all([
            this.userRepository.find({ order: { createdAt: 'ASC' } }),
            this.profileRepository.find({ relations: { user: true } }),
            this.billingRepository.find({ where: { period }, relations: { client: true } }),
        ]);

        const profileByUser = new Map(profiles.map(p => [p.user.id, p]));
        const billingByUser = new Map(billings.map(b => [b.client.id, b]));

        // El personal interno (admin/contador) no se factura a sí mismo
        const clients = users.filter(u => u.role !== UserRole.ADMIN && u.role !== UserRole.ACCOUNTANT);

        const rows = clients.map(user => {
            const profile = profileByUser.get(user.id);
            const billing = billingByUser.get(user.id);
            return {
                clientId: user.id,
                clientName: profile?.businessName || `${user.name} ${user.lastName}`.trim(),
                email: user.email,
                ruc: profile?.ruc ?? null,
                clientType: profile?.clientType ?? 'saas',
                hasSheet: Boolean(profile?.sheetCsvUrl),
                billing: billing
                    ? {
                        id: billing.id,
                        totalSales: Number(billing.totalSales),
                        commissionRate: Number(billing.commissionRate),
                        commissionAmount: Number(billing.commissionAmount),
                        currency: billing.currency,
                        status: billing.status,
                        invoiceRef: billing.invoiceRef,
                        invoicedAt: billing.invoicedAt,
                        salesSource: billing.salesSource,
                        notes: billing.notes,
                    }
                    : null,
            };
        });

        const loaded = rows.filter(r => r.billing);
        const totals = {
            clients: rows.length,
            loaded: loaded.length,
            pending: loaded.filter(r => r.billing!.status === 'pendiente').length,
            invoiced: loaded.filter(r => r.billing!.status === 'facturado').length,
            collected: loaded.filter(r => r.billing!.status === 'cobrado').length,
            totalSales: this.round(loaded.reduce((s, r) => s + r.billing!.totalSales, 0)),
            totalCommission: this.round(loaded.reduce((s, r) => s + r.billing!.commissionAmount, 0)),
            pendingCommission: this.round(
                loaded
                    .filter(r => r.billing!.status !== 'cobrado')
                    .reduce((s, r) => s + r.billing!.commissionAmount, 0),
            ),
        };

        return { period, totals, rows };
    }

    /**
     * Consulta las ventas reales del cliente en el periodo (hoja de
     * cálculo del AppScript + marketplaces sincronizados) para no tener
     * que teclearlas a mano.
     */
    async fetchSales(clientId: string, period: string) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
            throw new BadRequestException('El periodo debe tener el formato YYYY-MM.');
        }
        const user = await this.userRepository.findOne({ where: { id: clientId } });
        if (!user) throw new NotFoundException('Cliente no encontrado');

        const { from, to } = this.periodRange(period);
        const report = await this.reportsService.getSalesReport(clientId, from, to);

        const usedSheet = report.sources.sheets && !report.sources.sheetError;
        return {
            period,
            totalSales: report.totals.sales,
            orders: report.totals.orders,
            byChannel: report.byChannel,
            source: usedSheet && report.sources.marketplaces
                ? 'sheets'
                : usedSheet
                    ? 'sheets'
                    : report.sources.marketplaces
                        ? 'marketplaces'
                        : 'manual',
            sheetError: report.sources.sheetError,
            warning:
                report.totals.sales === 0
                    ? 'No se encontraron ventas en el periodo. Revisa la hoja vinculada del cliente o carga el monto a mano.'
                    : null,
        };
    }

    /** Crea o actualiza la liquidación del cliente para ese periodo. */
    async upsert(dto: UpsertBillingDto) {
        const user = await this.userRepository.findOne({ where: { id: dto.clientId } });
        if (!user) throw new NotFoundException('Cliente no encontrado');

        let billing = await this.billingRepository.findOne({
            where: { client: { id: dto.clientId }, period: dto.period },
        });

        const commissionAmount = this.round((dto.totalSales * dto.commissionRate) / 100);

        if (!billing) {
            billing = this.billingRepository.create({
                client: { id: dto.clientId } as any,
                period: dto.period,
            });
        }

        billing.totalSales = dto.totalSales;
        billing.commissionRate = dto.commissionRate;
        billing.commissionAmount = commissionAmount;
        billing.currency = dto.currency || 'PEN';
        billing.salesSource = dto.salesSource || 'manual';
        if (dto.notes !== undefined) billing.notes = dto.notes;

        return this.billingRepository.save(billing);
    }

    /** Marca facturado/cobrado y guarda el número de comprobante. */
    async updateStatus(id: string, dto: UpdateBillingStatusDto) {
        const billing = await this.billingRepository.findOne({ where: { id } });
        if (!billing) throw new NotFoundException('Liquidación no encontrada');

        if (dto.status) billing.status = dto.status;
        if (dto.invoiceRef !== undefined) billing.invoiceRef = dto.invoiceRef;
        if (dto.notes !== undefined) billing.notes = dto.notes;

        if (dto.invoicedAt !== undefined) {
            billing.invoicedAt = dto.invoicedAt;
        } else if (dto.status === 'facturado' && !billing.invoicedAt) {
            // Si se marca como facturado sin fecha, se asume hoy
            billing.invoicedAt = new Date().toISOString().slice(0, 10);
        }

        return this.billingRepository.save(billing);
    }

    async remove(id: string) {
        const billing = await this.billingRepository.findOne({ where: { id } });
        if (!billing) throw new NotFoundException('Liquidación no encontrada');
        await this.billingRepository.remove(billing);
        return { message: 'Liquidación eliminada' };
    }

    /** Histórico de un cliente para ver su evolución. */
    async getClientHistory(clientId: string) {
        const billings = await this.billingRepository.find({
            where: { client: { id: clientId } },
            order: { period: 'DESC' },
        });
        return billings.map(b => ({
            ...b,
            totalSales: Number(b.totalSales),
            commissionRate: Number(b.commissionRate),
            commissionAmount: Number(b.commissionAmount),
        }));
    }

    /** Comisiones por mes de los últimos 12 periodos. */
    async getTrend() {
        const rows = await this.billingRepository
            .createQueryBuilder('b')
            .select('b.period', 'period')
            .addSelect('SUM(b.commissionAmount)', 'commission')
            .addSelect('SUM(b.totalSales)', 'sales')
            .groupBy('b.period')
            .orderBy('b.period', 'DESC')
            .limit(12)
            .getRawMany();

        return rows
            .map(r => ({
                period: r.period,
                commission: Number(r.commission),
                sales: Number(r.sales),
            }))
            .reverse();
    }
}
