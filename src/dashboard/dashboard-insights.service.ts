import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { MarketplaceOrder } from '../sync/entities/marketplace-order.entity';
import { ListingLink } from '../sync/entities/listing-link.entity';
import { SyncChangeRequest } from '../sync/entities/sync-change-request.entity';
import { Product } from '../products/entities/product.entity';
import { User } from '../users/entities/user.entity';
import { ClientProfile } from '../admin/entities/client-profile.entity';
import { Payment } from '../admin/entities/payment.entity';
import { MonthlyBilling } from '../admin/entities/monthly-billing.entity';
import {
    comisionDelMes,
    estadoDePago,
    hoyEnLima,
    mensualizar,
    ModeloDeCobro,
    proponerPlan,
} from '../admin/plan-comercial';

/** Un producto con pocas unidades frente a su ritmo de venta: se avisa con estos días de margen. */
const DIAS_DE_MARGEN = 14;
const LOW_STOCK_THRESHOLD = 5;

const redondear = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Primer instante del mes (en hora de Lima) que está `desplazamiento` meses del actual. */
export function inicioDeMesLima(hoy: string, desplazamiento = 0): Date {
    const [a, m] = hoy.split('-').map(Number);
    // 00:00 en Lima = 05:00 UTC
    return new Date(Date.UTC(a, m - 1 + desplazamiento, 1, 5, 0, 0));
}

/** Resumen del plan comercial tal como lo ve el cliente (y la agencia). */
export interface ResumenDePlan {
    modelo: ModeloDeCobro;
    moneda: string;
    cuotaFija: number | null;
    frecuencia: string;
    tasa: number | null;
    proximoPago: string | null;
    estadoPago: 'al_dia' | 'por_vencer' | 'vence_hoy' | 'vencido' | null;
    diasParaPago: number | null;
    /** Ventas del mes sobre las que se calcula la comisión. */
    ventasMes: number;
    comisionAcumulada: number;
    comisionProyectada: number | null;
    /** Cuota mensualizada + comisión acumulada: lo que lleva este mes. */
    totalDelMes: number;
}

export function armarPlan(
    perfil: Pick<ClientProfile, 'billingModel' | 'monthlyFee' | 'feeFrequency' | 'commissionRate' | 'nextDueDate' | 'planCurrency'>,
    ventasMes: number,
    hoy: string,
): ResumenDePlan {
    const cobraCuota = perfil.billingModel === 'fijo' || perfil.billingModel === 'mixto';
    const cobraComision = perfil.billingModel === 'comision' || perfil.billingModel === 'mixto';
    const comision = cobraComision ? comisionDelMes(ventasMes, perfil.commissionRate, hoy) : { acumulada: 0, proyectada: null };
    const pago = cobraCuota ? estadoDePago(perfil.nextDueDate, hoy) : null;
    return {
        modelo: perfil.billingModel as ModeloDeCobro,
        moneda: perfil.planCurrency || 'PEN',
        cuotaFija: cobraCuota ? perfil.monthlyFee : null,
        frecuencia: perfil.feeFrequency,
        tasa: cobraComision ? perfil.commissionRate : null,
        proximoPago: cobraCuota ? perfil.nextDueDate : null,
        estadoPago: pago?.estado ?? null,
        diasParaPago: pago?.dias ?? null,
        ventasMes,
        comisionAcumulada: comision.acumulada,
        comisionProyectada: comision.proyectada,
        totalDelMes: redondear((cobraCuota ? mensualizar(perfil.monthlyFee, perfil.feeFrequency) : 0) + comision.acumulada),
    };
}

/**
 * Lo que ayuda en el día a día: a quien tiene una tienda, sus productos
 * ganadores, lo que debe despachar y lo que le cuesta su plan; a la agencia,
 * cuánto vende cada cliente, cuánto y cuándo hay que cobrarle y qué proponerle.
 * Todo sale de datos que el sistema ya tiene.
 */
@Injectable()
export class DashboardInsightsService {
    constructor(
        @InjectRepository(MarketplaceOrder) private readonly orders: Repository<MarketplaceOrder>,
        @InjectRepository(ListingLink) private readonly listings: Repository<ListingLink>,
        @InjectRepository(SyncChangeRequest) private readonly changes: Repository<SyncChangeRequest>,
        @InjectRepository(Product) private readonly products: Repository<Product>,
        @InjectRepository(User) private readonly users: Repository<User>,
        @InjectRepository(ClientProfile) private readonly profiles: Repository<ClientProfile>,
        @InjectRepository(Payment) private readonly payments: Repository<Payment>,
        @InjectRepository(MonthlyBilling) private readonly billings: Repository<MonthlyBilling>,
    ) { }

    // ─────────────────────────────────────────────────────────────
    // Cliente: su tienda
    // ─────────────────────────────────────────────────────────────

    async getInsights(scope: { userId: string; storeId: string }) {
        const hoy = hoyEnLima();
        const [ganadoras, porDespachar, ventasDiarias, pendientesDeRevision, plan] = await Promise.all([
            this.ganadoras(scope),
            this.porDespachar(scope.storeId),
            this.ventasDiarias(scope.storeId),
            this.changes.count({ where: { store: { id: scope.storeId }, status: 'pending' } }),
            this.planDelCliente(scope.userId, hoy),
        ]);
        return { ganadoras, porDespachar, ventasDiarias, pendientesDeRevision, plan };
    }

    /**
     * Lo que más se vende en los últimos 30 días. Cada ganadora lleva sus días
     * de stock al ritmo actual: una que se vende bien y se está acabando es la
     * que más conviene reponer y no dejar de publicar.
     */
    private async ganadoras(scope: { userId: string; storeId: string }) {
        const filas: { sku: string; title: string; unidades: string; importe: string }[] = await this.orders.query(
            `SELECT it->>'sku' AS sku,
                    MAX(it->>'title') AS title,
                    SUM(COALESCE((it->>'quantity')::numeric, 1)) AS unidades,
                    SUM(COALESCE((it->>'quantity')::numeric, 1) * COALESCE((it->>'unitPrice')::numeric, 0)) AS importe
               FROM marketplace_orders o,
                    jsonb_array_elements(CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::jsonb END) it
              WHERE o."storeId" = $1
                AND o."orderDate" >= NOW() - INTERVAL '30 days'
                AND COALESCE(it->>'sku', '') <> ''
              GROUP BY it->>'sku'
              ORDER BY unidades DESC, importe DESC
              LIMIT 5`,
            [scope.storeId],
        );
        if (!filas.length) return [];

        const skus = filas.map(f => f.sku);
        const productos = await this.products.find({
            where: [
                { sku: In(skus), store: { id: scope.storeId } },
                { sku: In(skus), store: IsNull(), owner: { id: scope.userId } },
            ],
        });
        const porSku = new Map(productos.map(p => [p.sku, p]));
        const enlaces = productos.length
            ? await this.listings.find({ where: { product: { id: In(productos.map(p => p.id)) } }, relations: { product: true } })
            : [];
        const fotoPorProducto = new Map<string, string>();
        for (const e of enlaces) if (e.imageUrl && !fotoPorProducto.has(e.product.id)) fotoPorProducto.set(e.product.id, e.imageUrl);

        return filas.map(f => {
            const producto = porSku.get(f.sku);
            const unidades = Number(f.unidades);
            const ritmoDiario = unidades / 30;
            const stock = producto?.stock ?? null;
            const diasDeStock = stock !== null && ritmoDiario > 0 ? Math.floor(stock / ritmoDiario) : null;
            return {
                sku: f.sku,
                nombre: producto?.name ?? f.title,
                unidades,
                importe: redondear(Number(f.importe)),
                stock,
                diasDeStock,
                imagen: producto ? (fotoPorProducto.get(producto.id) ?? producto.images?.[0]?.url ?? null) : null,
                // Se vende bien y se acaba pronto: reponer antes de que deje de publicarse.
                reponer: stock !== null && (stock <= LOW_STOCK_THRESHOLD || (diasDeStock !== null && diasDeStock <= DIAS_DE_MARGEN)),
            };
        });
    }

    /** Ventas con fecha límite de envío hoy o ya vencida, que aún no salieron. */
    private async porDespachar(storeId: string) {
        const fila = await this.orders.query(
            `SELECT COUNT(*) FILTER (WHERE o."shipByDate" < NOW()) AS vencidos,
                    COUNT(*) FILTER (WHERE o."shipByDate" >= NOW()) AS hoy
               FROM marketplace_orders o
              WHERE o."storeId" = $1
                AND o."shipByDate" IS NOT NULL
                AND o."shipByDate" >= NOW() - INTERVAL '14 days'
                AND o."shipByDate" < (date_trunc('day', NOW() AT TIME ZONE 'America/Lima') + INTERVAL '1 day') AT TIME ZONE 'America/Lima'
                AND o.status !~* '(shipped|delivered|cancel|completed|closed)'
                AND COALESCE(o.details->'shipping'->>'status', '') !~* '(shipped|delivered|cancel|completed)'`,
            [storeId],
        );
        const vencidos = Number(fila?.[0]?.vencidos ?? 0);
        const hoy = Number(fila?.[0]?.hoy ?? 0);
        return { vencidos, hoy, total: vencidos + hoy };
    }

    /** Ventas de los últimos 14 días, día por día (hora de Lima), con los días sin ventas en cero. */
    private async ventasDiarias(storeId: string) {
        const filas: { dia: string; pedidos: string; importe: string }[] = await this.orders.query(
            `SELECT to_char(o."orderDate" AT TIME ZONE 'America/Lima', 'YYYY-MM-DD') AS dia,
                    COUNT(*) AS pedidos,
                    COALESCE(SUM(o."totalAmount"), 0) AS importe
               FROM marketplace_orders o
              WHERE o."storeId" = $1
                AND o."orderDate" >= NOW() - INTERVAL '15 days'
              GROUP BY dia`,
            [storeId],
        );
        const porDia = new Map(filas.map(f => [f.dia, f]));
        const hoy = hoyEnLima();
        const [a, m, d] = hoy.split('-').map(Number);
        const salida: { dia: string; pedidos: number; importe: number }[] = [];
        for (let i = 13; i >= 0; i--) {
            const fecha = new Date(Date.UTC(a, m - 1, d - i)).toISOString().slice(0, 10);
            const f = porDia.get(fecha);
            salida.push({ dia: fecha, pedidos: Number(f?.pedidos ?? 0), importe: Number(f?.importe ?? 0) });
        }
        return salida;
    }

    /** Ventas de todas las tiendas de una persona desde una fecha: es la base de su comisión. */
    private async ventasDelDueno(userId: string, desde: Date, hasta?: Date): Promise<number> {
        const qb = this.orders
            .createQueryBuilder('o')
            .select('COALESCE(SUM(o."totalAmount"), 0)', 'importe')
            .where('o."ownerId" = :userId', { userId })
            .andWhere('o."orderDate" >= :desde', { desde });
        if (hasta) qb.andWhere('o."orderDate" < :hasta', { hasta });
        const fila = await qb.getRawOne();
        return Number(fila?.importe ?? 0);
    }

    /** El plan de quien mira: solo existe si la agencia le definió uno. */
    private async planDelCliente(userId: string, hoy: string) {
        const perfil = await this.profiles.findOne({ where: { user: { id: userId } } });
        if (!perfil || perfil.billingModel === 'ninguno') return null;

        const desdeEsteMes = inicioDeMesLima(hoy);
        const [ventasMes, ventasMesPasado, ultimoPago, liquidacion] = await Promise.all([
            this.ventasDelDueno(userId, desdeEsteMes),
            this.ventasDelDueno(userId, inicioDeMesLima(hoy, -1), desdeEsteMes),
            this.payments.findOne({ where: { client: { id: userId } }, order: { paidAt: 'DESC' } }),
            this.billings.findOne({ where: { client: { id: userId }, period: this.periodoAnterior(hoy) } }),
        ]);

        const plan = armarPlan(perfil, ventasMes, hoy);
        return {
            ...plan,
            ventasMesAnterior: ventasMesPasado,
            ultimoPago: ultimoPago ? { fecha: ultimoPago.paidAt, monto: Number(ultimoPago.amount), concepto: ultimoPago.concept } : null,
            // La liquidación del mes pasado, si hay comisión: cuánto fue y en qué estado está.
            liquidacionMesAnterior: liquidacion
                ? { periodo: liquidacion.period, comision: Number(liquidacion.commissionAmount), estado: liquidacion.status }
                : null,
        };
    }

    private periodoAnterior(hoy: string): string {
        const [a, m] = hoy.split('-').map(Number);
        const d = new Date(Date.UTC(a, m - 2, 1));
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    }

    // ─────────────────────────────────────────────────────────────
    // Agencia: todos los clientes
    // ─────────────────────────────────────────────────────────────

    /**
     * Control de la cartera: cuánto vende cada cliente, qué se le cobra, cuándo
     * vence y qué proponerle. Las cifras salen de consultas agrupadas, no de una
     * por cliente, para que no se degrade al crecer la cartera.
     */
    async getAgency() {
        const hoy = hoyEnLima();
        const desdeEsteMes = inicioDeMesLima(hoy);
        const desdeHace3 = inicioDeMesLima(hoy, -3);

        const clientes = await this.users.find({
            where: [{ role: 'user' }, { role: 'moderator' }],
            order: { createdAt: 'DESC' },
        });
        if (!clientes.length) return this.agenciaVacia(hoy);

        const ids = clientes.map(c => c.id);
        const [perfiles, ventas, ultimosPagos, cobradoMes, liquidaciones] = await Promise.all([
            this.profiles.find({ where: ids.map(id => ({ user: { id } })) as any, relations: { user: true } }),

            // Ventas por cliente y mes (hora de Lima), de los 3 meses anteriores y el actual
            this.orders.query(
                `SELECT o."ownerId" AS dueno,
                        to_char(o."orderDate" AT TIME ZONE 'America/Lima', 'YYYY-MM') AS mes,
                        COUNT(*) AS pedidos,
                        COALESCE(SUM(o."totalAmount"), 0) AS importe
                   FROM marketplace_orders o
                  WHERE o."ownerId" = ANY($1) AND o."orderDate" >= $2
                  GROUP BY o."ownerId", mes`,
                [ids, desdeHace3],
            ),

            // El último pago de cada cliente (DISTINCT ON necesita las columnas en crudo para traer el clientId).
            this.payments
                .createQueryBuilder('p')
                .select(['p."clientId" AS "clientId"', 'p."paidAt" AS "paidAt"', 'p.amount AS amount'])
                .distinctOn(['p."clientId"'])
                .where('p."clientId" IN (:...ids)', { ids })
                .orderBy('p."clientId"')
                .addOrderBy('p."paidAt"', 'DESC')
                .getRawMany<{ clientId: string; paidAt: string; amount: string }>(),

            this.payments
                .createQueryBuilder('p')
                .select('COALESCE(SUM(p.amount), 0)', 'total')
                .where('"p"."paidAt" >= :desde', { desde: `${hoy.slice(0, 7)}-01` })
                .getRawOne(),

            this.billings.find({ where: { period: this.periodoAnterior(hoy) }, relations: { client: true } }),
        ]);

        const perfilDe = new Map(perfiles.map(p => [p.user?.id, p]));
        const pagoDe = new Map(ultimosPagos.map(p => [p.clientId, p]));
        const liquidacionDe = new Map(liquidaciones.map(l => [l.client.id, l]));
        const ventasDe = new Map<string, Map<string, { pedidos: number; importe: number }>>();
        for (const f of ventas) {
            const meses = ventasDe.get(f.dueno) ?? new Map();
            meses.set(f.mes, { pedidos: Number(f.pedidos), importe: Number(f.importe) });
            ventasDe.set(f.dueno, meses);
        }
        const mesesAnteriores = [-1, -2, -3].map(d => this.mesDe(hoy, d));
        const mesActual = hoy.slice(0, 7);

        const filas = clientes.map(cliente => {
            const perfil = perfilDe.get(cliente.id);
            const meses = ventasDe.get(cliente.id) ?? new Map();
            const ventasMes = meses.get(mesActual)?.importe ?? 0;
            const anteriores = mesesAnteriores.map(m => meses.get(m)?.importe ?? 0);

            const plan = perfil
                ? armarPlan(perfil, ventasMes, hoy)
                : armarPlan({ billingModel: 'ninguno', monthlyFee: null, feeFrequency: 'mensual', commissionRate: null, nextDueDate: null, planCurrency: 'PEN' }, ventasMes, hoy);
            const propuesta = proponerPlan({
                modelo: plan.modelo,
                cuotaFija: perfil?.monthlyFee ?? null,
                frecuencia: perfil?.feeFrequency ?? 'mensual',
                tasa: perfil?.commissionRate ?? null,
                ventasMes,
                ventasMesesAnteriores: anteriores,
                moneda: plan.moneda,
            });
            const pago = pagoDe.get(cliente.id);
            const liq = liquidacionDe.get(cliente.id);

            return {
                id: cliente.id,
                nombre: `${cliente.name ?? ''} ${cliente.lastName ?? ''}`.trim() || cliente.email,
                email: cliente.email,
                empresa: perfil?.businessName || cliente.nameCompany || null,
                estado: perfil?.status ?? (cliente.isActive ? 'activo' : 'pausado'),
                ventas: {
                    mes: ventasMes,
                    pedidosMes: meses.get(mesActual)?.pedidos ?? 0,
                    mesesAnteriores: mesesAnteriores.map((periodo, i) => ({ periodo, importe: anteriores[i] })),
                },
                plan,
                ultimoPago: pago ? { fecha: pago.paidAt, monto: Number(pago.amount) } : null,
                liquidacionMesAnterior: liq ? { periodo: liq.period, comision: Number(liq.commissionAmount), estado: liq.status } : null,
                propuesta,
                notasDePropuesta: perfil?.proposalNotes ?? null,
            };
        });

        // Primero lo que hay que cobrar o vigilar: vencidos, luego por vencer, luego el resto por ventas.
        const peso = (f: typeof filas[number]) =>
            f.plan.estadoPago === 'vencido' ? 3 : f.plan.estadoPago === 'vence_hoy' ? 2.5 : f.plan.estadoPago === 'por_vencer' ? 2 : 0;
        filas.sort((a, b) => peso(b) - peso(a) || b.ventas.mes - a.ventas.mes);

        const activos = filas.filter(f => f.estado === 'activo');
        const cobrables = (f: typeof filas[number]) => f.plan.modelo === 'fijo' || f.plan.modelo === 'mixto';
        const vencidos = filas.filter(f => f.plan.estadoPago === 'vencido');
        const proximos = filas.filter(f => f.plan.estadoPago === 'por_vencer' || f.plan.estadoPago === 'vence_hoy');
        const montoCuota = (f: typeof filas[number]) => f.plan.cuotaFija ?? 0;

        return {
            hoy,
            totales: {
                clientes: filas.length,
                ventasDelMes: redondear(filas.reduce((s, f) => s + f.ventas.mes, 0)),
                pedidosDelMes: filas.reduce((s, f) => s + f.ventas.pedidosMes, 0),
                // Lo recurrente: cuotas fijas de clientes activos, llevadas a mes.
                ingresoFijoMensual: redondear(activos.filter(cobrables).reduce((s, f) => s + mensualizar(f.plan.cuotaFija, f.plan.frecuencia), 0)),
                comisionAcumulada: redondear(activos.reduce((s, f) => s + f.plan.comisionAcumulada, 0)),
                comisionProyectada: redondear(activos.reduce((s, f) => s + (f.plan.comisionProyectada ?? f.plan.comisionAcumulada), 0)),
                cobradoEsteMes: Number(cobradoMes?.total ?? 0),
                vencidos: { cantidad: vencidos.length, monto: redondear(vencidos.reduce((s, f) => s + montoCuota(f), 0)) },
                proximos: { cantidad: proximos.length, monto: redondear(proximos.reduce((s, f) => s + montoCuota(f), 0)) },
                sinPlan: filas.filter(f => f.plan.modelo === 'ninguno').length,
                porModelo: {
                    fijo: filas.filter(f => f.plan.modelo === 'fijo').length,
                    comision: filas.filter(f => f.plan.modelo === 'comision').length,
                    mixto: filas.filter(f => f.plan.modelo === 'mixto').length,
                },
            },
            clientes: filas,
        };
    }

    private agenciaVacia(hoy: string) {
        return {
            hoy,
            totales: {
                clientes: 0, ventasDelMes: 0, pedidosDelMes: 0, ingresoFijoMensual: 0, comisionAcumulada: 0, comisionProyectada: 0,
                cobradoEsteMes: 0, vencidos: { cantidad: 0, monto: 0 }, proximos: { cantidad: 0, monto: 0 }, sinPlan: 0,
                porModelo: { fijo: 0, comision: 0, mixto: 0 },
            },
            clientes: [],
        };
    }

    private mesDe(hoy: string, desplazamiento: number): string {
        const [a, m] = hoy.split('-').map(Number);
        const d = new Date(Date.UTC(a, m - 1 + desplazamiento, 1));
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    }
}
