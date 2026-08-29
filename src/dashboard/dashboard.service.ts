import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MarketplaceConnection } from '../sync/entities/marketplace-connection.entity';
import { ListingLink } from '../sync/entities/listing-link.entity';
import { MarketplaceOrder } from '../sync/entities/marketplace-order.entity';
import { Product } from '../products/entities/product.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { User } from '../users/entities/user.entity';
import { ClientProfile } from '../admin/entities/client-profile.entity';

/** Por debajo de estas unidades, un producto publicado se considera en riesgo. */
const LOW_STOCK_THRESHOLD = 5;

/** Primer día del mes actual, en hora local. */
function inicioDeMes(desplazamiento = 0): Date {
    const hoy = new Date();
    return new Date(hoy.getFullYear(), hoy.getMonth() + desplazamiento, 1);
}

@Injectable()
export class DashboardService {
    constructor(
        @InjectRepository(MarketplaceConnection) private readonly connections: Repository<MarketplaceConnection>,
        @InjectRepository(ListingLink) private readonly listings: Repository<ListingLink>,
        @InjectRepository(MarketplaceOrder) private readonly orders: Repository<MarketplaceOrder>,
        @InjectRepository(Product) private readonly products: Repository<Product>,
        @InjectRepository(Notification) private readonly notifications: Repository<Notification>,
        @InjectRepository(User) private readonly users: Repository<User>,
        @InjectRepository(ClientProfile) private readonly profiles: Repository<ClientProfile>,
    ) { }

    /**
     * Resumen del negocio de una cuenta: lo que su dueño necesita ver al
     * entrar. Todo sale de datos que el sistema ya tiene — no hay métricas
     * inventadas ni de relleno.
     */
    async getSummary(userId: string) {
        const desdeEsteMes = inicioDeMes();
        const desdeMesPasado = inicioDeMes(-1);

        const [
            canales,
            catalogo,
            publicaciones,
            ventasMes,
            ventasMesPasado,
            stockBajo,
            porCanal,
            avisos,
        ] = await Promise.all([
            this.connections.find({ where: { owner: { id: userId } } }),

            this.products
                .createQueryBuilder('p')
                .select('COUNT(*)', 'total')
                .addSelect(`COUNT(*) FILTER (WHERE p.status = 'draft')`, 'borradores')
                .where('p.ownerId = :userId', { userId })
                .getRawOne(),

            this.listings
                .createQueryBuilder('l')
                .innerJoin('l.product', 'p')
                .select(`COUNT(*) FILTER (WHERE l."syncStatus" = 'published')`, 'publicados')
                .addSelect(`COUNT(*) FILTER (WHERE l."syncStatus" = 'error')`, 'conError')
                .addSelect(`COUNT(*) FILTER (WHERE l."syncStatus" = 'pending')`, 'pendientes')
                .where('p.ownerId = :userId', { userId })
                .getRawOne(),

            this.sumarVentas(userId, desdeEsteMes),
            this.sumarVentas(userId, desdeMesPasado, desdeEsteMes),

            this.products
                .createQueryBuilder('p')
                .innerJoin(ListingLink, 'l', `l."productId" = p.id AND l."syncStatus" = 'published'`)
                .select(['p.id AS id', 'p.name AS name', 'p.sku AS sku', 'p.stock AS stock'])
                .where('p.ownerId = :userId', { userId })
                .andWhere('p.stock <= :umbral', { umbral: LOW_STOCK_THRESHOLD })
                .orderBy('p.stock', 'ASC')
                .limit(8)
                .getRawMany(),

            this.orders
                .createQueryBuilder('o')
                .select('o.marketplace', 'marketplace')
                .addSelect('COUNT(*)', 'pedidos')
                .addSelect('COALESCE(SUM(o."totalAmount"), 0)', 'importe')
                .where('o.ownerId = :userId', { userId })
                .andWhere('o."orderDate" >= :desde', { desde: desdeEsteMes })
                .groupBy('o.marketplace')
                .getRawMany(),

            this.notifications
                .createQueryBuilder('n')
                .select(`COUNT(*) FILTER (WHERE n.read = false)`, 'sinLeer')
                .addSelect(`COUNT(*) FILTER (WHERE n.severity = 'error' AND n.read = false)`, 'problemas')
                .where('n.ownerId = :userId', { userId })
                .getRawOne(),
        ]);

        return {
            canales: canales.map(c => ({
                marketplace: c.marketplace,
                nickname: c.externalNickname || c.externalUserId,
                status: c.status,
            })),
            catalogo: {
                total: Number(catalogo?.total ?? 0),
                borradores: Number(catalogo?.borradores ?? 0),
                publicados: Number(publicaciones?.publicados ?? 0),
                conError: Number(publicaciones?.conError ?? 0),
                pendientes: Number(publicaciones?.pendientes ?? 0),
            },
            ventas: {
                mes: ventasMes,
                mesAnterior: ventasMesPasado,
                // Cuánto ha variado respecto al mes pasado, en porcentaje.
                variacion: this.variacion(ventasMes.importe, ventasMesPasado.importe),
                porCanal: porCanal.map(r => ({
                    marketplace: r.marketplace,
                    pedidos: Number(r.pedidos),
                    importe: Number(r.importe),
                })),
            },
            stockBajo: stockBajo.map(p => ({
                id: p.id,
                name: p.name,
                sku: p.sku,
                stock: Number(p.stock),
            })),
            avisos: {
                sinLeer: Number(avisos?.sinLeer ?? 0),
                problemas: Number(avisos?.problemas ?? 0),
            },
        };
    }

    /** Pedidos e importe de una cuenta en un rango de fechas. */
    private async sumarVentas(userId: string, desde: Date, hasta?: Date) {
        const qb = this.orders
            .createQueryBuilder('o')
            .select('COUNT(*)', 'pedidos')
            .addSelect('COALESCE(SUM(o."totalAmount"), 0)', 'importe')
            .where('o.ownerId = :userId', { userId })
            .andWhere('o."orderDate" >= :desde', { desde });

        if (hasta) qb.andWhere('o."orderDate" < :hasta', { hasta });

        const row = await qb.getRawOne();
        return { pedidos: Number(row?.pedidos ?? 0), importe: Number(row?.importe ?? 0) };
    }

    /**
     * Variación porcentual entre dos importes.
     * Devuelve null si el mes anterior fue cero: un "+100%" partiendo de
     * nada no dice nada y confunde más que ayudar.
     */
    private variacion(actual: number, anterior: number): number | null {
        if (!anterior) return null;
        return Math.round(((actual - anterior) / anterior) * 100);
    }

    /**
     * Panel de agencia: una fila por cliente con lo que hace falta para
     * saber, de un vistazo, cuál necesita atención.
     *
     * Las cifras se calculan con consultas agrupadas y no una por cliente,
     * para que el panel no se degrade a medida que crece la cartera.
     */
    async getAccounts() {
        const desdeEsteMes = inicioDeMes();

        const clientes = await this.users.find({
            where: [{ role: 'user' }, { role: 'moderator' }],
            order: { createdAt: 'DESC' },
        });
        if (!clientes.length) return { cuentas: [], totales: { clientes: 0, pedidos: 0, importe: 0 } };

        const ids = clientes.map(c => c.id);

        const [perfiles, conexiones, ventas, publicaciones, problemas] = await Promise.all([
            this.profiles.find({ where: ids.map(id => ({ user: { id } })) as any, relations: { user: true } }),

            this.connections
                .createQueryBuilder('c')
                .select(['c."ownerId" AS "ownerId"', 'c.marketplace AS marketplace', 'c.status AS status'])
                .where('c."ownerId" IN (:...ids)', { ids })
                .getRawMany(),

            this.orders
                .createQueryBuilder('o')
                .select('o."ownerId"', 'ownerId')
                .addSelect('COUNT(*)', 'pedidos')
                .addSelect('COALESCE(SUM(o."totalAmount"), 0)', 'importe')
                .where('o."ownerId" IN (:...ids)', { ids })
                .andWhere('o."orderDate" >= :desde', { desde: desdeEsteMes })
                .groupBy('o."ownerId"')
                .getRawMany(),

            this.listings
                .createQueryBuilder('l')
                .innerJoin('l.product', 'p')
                .select('p."ownerId"', 'ownerId')
                .addSelect(`COUNT(*) FILTER (WHERE l."syncStatus" = 'published')`, 'publicados')
                .addSelect(`COUNT(*) FILTER (WHERE l."syncStatus" = 'error')`, 'conError')
                .where('p."ownerId" IN (:...ids)', { ids })
                .groupBy('p."ownerId"')
                .getRawMany(),

            this.notifications
                .createQueryBuilder('n')
                .select('n."ownerId"', 'ownerId')
                .addSelect('COUNT(*)', 'problemas')
                .where('n."ownerId" IN (:...ids)', { ids })
                .andWhere(`n.severity = 'error' AND n.read = false`)
                .groupBy('n."ownerId"')
                .getRawMany(),
        ]);

        const porCliente = <T extends { ownerId: string }>(filas: T[]) =>
            new Map(filas.map(f => [f.ownerId, f]));

        const ventasPorCliente = porCliente(ventas);
        const listadosPorCliente = porCliente(publicaciones);
        const problemasPorCliente = porCliente(problemas);
        const perfilPorCliente = new Map(perfiles.map(p => [p.user?.id, p]));

        const canalesPorCliente = new Map<string, { marketplace: string; status: string }[]>();
        for (const fila of conexiones) {
            const lista = canalesPorCliente.get(fila.ownerId) ?? [];
            lista.push({ marketplace: fila.marketplace, status: fila.status });
            canalesPorCliente.set(fila.ownerId, lista);
        }

        const cuentas = clientes.map(cliente => {
            const venta = ventasPorCliente.get(cliente.id) as any;
            const listado = listadosPorCliente.get(cliente.id) as any;
            const perfil = perfilPorCliente.get(cliente.id);
            const canales = canalesPorCliente.get(cliente.id) ?? [];

            return {
                id: cliente.id,
                nombre: `${cliente.name ?? ''} ${cliente.lastName ?? ''}`.trim() || cliente.email,
                email: cliente.email,
                empresa: perfil?.businessName || cliente.nameCompany || null,
                estado: perfil?.status ?? (cliente.isActive ? 'activo' : 'pausado'),
                canales,
                canalesCaidos: canales.filter(c => c.status !== 'active').length,
                ventas: {
                    pedidos: Number(venta?.pedidos ?? 0),
                    importe: Number(venta?.importe ?? 0),
                },
                publicaciones: {
                    publicados: Number(listado?.publicados ?? 0),
                    conError: Number(listado?.conError ?? 0),
                },
                problemasSinLeer: Number((problemasPorCliente.get(cliente.id) as any)?.problemas ?? 0),
            };
        });

        // Primero quien necesita atención: conexiones caídas, luego errores.
        cuentas.sort((a, b) => {
            const peso = (c: typeof a) => c.canalesCaidos * 100 + c.publicaciones.conError * 10 + c.problemasSinLeer;
            return peso(b) - peso(a);
        });

        return {
            cuentas,
            totales: {
                clientes: cuentas.length,
                pedidos: cuentas.reduce((s, c) => s + c.ventas.pedidos, 0),
                importe: cuentas.reduce((s, c) => s + c.ventas.importe, 0),
            },
        };
    }
}
