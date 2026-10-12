import { Injectable, NotFoundException } from '@nestjs/common';
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
import { DashboardService } from './dashboard.service';
import { ClientStoresService } from './client-stores';
import {
    CicloDeCobro,
    cicloDeCobro,
    comisionDelCiclo,
    desglosarIgv,
    estadoDePago,
    hoyEnLima,
    IGV_PORCENTAJE,
    Importe,
    mensualizar,
    ModeloDeCobro,
    proponerPlan,
    sumarImportes,
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

/** 00:00 de ese día en Lima (UTC-5), como instante. */
export function limaMedianoche(dia: string): Date {
    return new Date(`${dia}T05:00:00.000Z`);
}

/** Resumen del plan comercial tal como lo ve el cliente (y la agencia). */
export interface ResumenDePlan {
    modelo: ModeloDeCobro;
    moneda: string;
    frecuencia: string;
    /** Cuota pactada por periodo (con o sin IGV, según cuotaIncluyeIgv). */
    cuotaFija: number | null;
    cuotaIncluyeIgv: boolean;
    tasa: number | null;
    comisionIncluyeIgv: boolean;
    /** Fecha del próximo cobro. */
    proximoPago: string | null;
    estadoPago: 'al_dia' | 'por_vencer' | 'vence_hoy' | 'vencido' | null;
    diasParaPago: number | null;
    /** De cuándo a cuándo se cuentan las ventas de este cobro. */
    ciclo: CicloDeCobro;
    /** Precio de los productos vendidos este mes calendario. */
    ventasMes: number;
    /** Precio de los productos vendidos dentro del ciclo de cobro. */
    ventasCiclo: number;
    /** Comisión acumulada en el ciclo, tal como se pactó (con o sin IGV). */
    comisionAcumulada: number;
    /** Lo que la comisión sumaría al llegar a la fecha de cobro, con el ritmo actual. */
    comisionProyectada: number | null;
    /** Lo que se cobrará en la fecha de cobro, desglosado con su IGV. */
    cobro: {
        cuota: Importe | null;
        comision: Importe | null;
        subtotal: number;
        igv: number;
        total: number;
    };
    igvPorcentaje: number;
}

type PerfilDePlan = Pick<
    ClientProfile,
    'billingModel' | 'monthlyFee' | 'feeFrequency' | 'commissionRate' | 'nextDueDate' | 'planCurrency' | 'feeIncludesIgv' | 'commissionIncludesIgv' | 'planStartDate'
>;

export function armarPlan(perfil: PerfilDePlan, ventasMes: number, ventasCiclo: number, hoy: string): ResumenDePlan {
    const cobraCuota = perfil.billingModel === 'fijo' || perfil.billingModel === 'mixto';
    const cobraComision = perfil.billingModel === 'comision' || perfil.billingModel === 'mixto';
    const ciclo = cicloDeCobro(perfil.nextDueDate, perfil.feeFrequency, perfil.planStartDate, hoy);
    const comision = cobraComision ? comisionDelCiclo(ventasCiclo, perfil.commissionRate, ciclo, hoy) : { acumulada: 0, proyectada: null };
    // La fecha de cobro vale para cualquier plan con algo que cobrar: cuota, comisión o ambos.
    const pago = perfil.billingModel !== 'ninguno' ? estadoDePago(perfil.nextDueDate, hoy) : null;

    const cuota = cobraCuota ? desglosarIgv(perfil.monthlyFee, !!perfil.feeIncludesIgv) : null;
    const comisionImporte = cobraComision ? desglosarIgv(comision.acumulada, !!perfil.commissionIncludesIgv) : null;

    return {
        modelo: perfil.billingModel as ModeloDeCobro,
        moneda: perfil.planCurrency || 'PEN',
        frecuencia: perfil.feeFrequency,
        cuotaFija: cobraCuota ? perfil.monthlyFee : null,
        cuotaIncluyeIgv: !!perfil.feeIncludesIgv,
        tasa: cobraComision ? perfil.commissionRate : null,
        comisionIncluyeIgv: !!perfil.commissionIncludesIgv,
        proximoPago: perfil.billingModel !== 'ninguno' ? perfil.nextDueDate : null,
        estadoPago: pago?.estado ?? null,
        diasParaPago: pago?.dias ?? null,
        ciclo,
        ventasMes,
        ventasCiclo,
        comisionAcumulada: comision.acumulada,
        comisionProyectada: comision.proyectada,
        cobro: { cuota, comision: comisionImporte, ...sumarImportes(cuota, comisionImporte) },
        igvPorcentaje: IGV_PORCENTAJE,
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
        private readonly summary: DashboardService,
        private readonly clientStores: ClientStoresService,
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
                    COALESCE(SUM(COALESCE(o."productsAmount", o."totalAmount")), 0) AS importe
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

    /**
     * Ventas de todas las tiendas de un cliente desde una fecha: es la base de su comisión.
     * Sus tiendas son las que se le asignaron, las que son suyas o las que llevan el nombre
     * de su negocio (ver client-stores.ts), sin importar quién conectó las cuentas.
     */
    private async ventasDeCliente(clienteId: string, desde: Date, hasta?: Date): Promise<number> {
        const { tiendasDe } = await this.clientStores.mapa();
        const ids = tiendasDe.get(clienteId) ?? [];
        const qb = this.orders
            .createQueryBuilder('o')
            .select('COALESCE(SUM(COALESCE(o."productsAmount", o."totalAmount")), 0)', 'importe')
            .where('(o."storeId" IN (:...ids) OR (o."storeId" IS NULL AND o."ownerId" = :clienteId))', { ids: ids.length ? ids : ['00000000-0000-0000-0000-000000000000'], clienteId })
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
        const ciclo = cicloDeCobro(perfil.nextDueDate, perfil.feeFrequency, perfil.planStartDate, hoy);
        const [ventasMes, ventasMesPasado, ventasCiclo, ultimoPago, liquidacion] = await Promise.all([
            this.ventasDeCliente(userId, desdeEsteMes),
            this.ventasDeCliente(userId, inicioDeMesLima(hoy, -1), desdeEsteMes),
            this.ventasDeCliente(userId, limaMedianoche(ciclo.desde), limaMedianoche(ciclo.hasta)),
            this.payments.findOne({ where: { client: { id: userId } }, order: { paidAt: 'DESC' } }),
            this.billings.findOne({ where: { client: { id: userId }, period: this.periodoAnterior(hoy) } }),
        ]);

        const plan = armarPlan(perfil, ventasMes, ventasCiclo, hoy);
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
        const mesActual = hoy.slice(0, 7);
        const mesesAnteriores = [-1, -2, -3].map(d => this.mesDe(hoy, d));

        const clientes = await this.users.find({
            where: [{ role: 'user' }, { role: 'moderator' }],
            order: { createdAt: 'DESC' },
        });
        if (!clientes.length) return this.agenciaVacia(hoy);

        const ids = clientes.map(c => c.id);
        const perfiles = await this.profiles.find({ where: ids.map(id => ({ user: { id } })) as any, relations: { user: true } });
        const perfilDe = new Map(perfiles.map(p => [p.user?.id, p]));

        // Ciclo de cobro de cada cliente; las ventas se leen desde el más antiguo de todos.
        const ciclos = new Map(
            clientes.map(c => {
                const p = perfilDe.get(c.id);
                return [c.id, cicloDeCobro(p?.nextDueDate, p?.feeFrequency, p?.planStartDate, hoy)] as const;
            }),
        );
        const desdeMes = `${mesesAnteriores[mesesAnteriores.length - 1]}-01`;
        const desdeVentas = [desdeMes, ...[...ciclos.values()].map(c => c.desde)].sort()[0];

        const mapa = await this.clientStores.mapa();
        const conexionesPorTienda: { tienda: string; cantidad: string }[] = await this.orders.query(
            `SELECT "storeId" AS tienda, COUNT(*) AS cantidad FROM marketplace_connections WHERE "storeId" IS NOT NULL GROUP BY "storeId"`,
        );
        const [ventas, ultimosPagos, cobradoMes, liquidaciones, global] = await Promise.all([
            // Ventas por tienda y DÍA (hora de Lima): de ahí salen el mes, los anteriores y el ciclo de cobro de cada cliente.
            // Cada tienda se atribuye a su cliente (ver client-stores.ts), no a quien conectó las cuentas.
            this.orders.query(
                `SELECT o."storeId" AS tienda, o."ownerId" AS dueno,
                        to_char(o."orderDate" AT TIME ZONE 'America/Lima', 'YYYY-MM-DD') AS dia,
                        COUNT(*) AS pedidos,
                        COALESCE(SUM(COALESCE(o."productsAmount", o."totalAmount")), 0) AS importe
                   FROM marketplace_orders o
                  WHERE o."orderDate" >= $1
                  GROUP BY o."storeId", o."ownerId", dia`,
                [limaMedianoche(desdeVentas)],
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
                .where('"p"."paidAt" >= :desde', { desde: `${mesActual}-01` })
                .getRawOne(),

            this.billings.find({ where: { period: this.periodoAnterior(hoy) }, relations: { client: true } }),

            // El superadmin ve TODO lo que se vendió, también lo de tiendas que no son de ningún cliente de la lista.
            this.orders.query(
                `SELECT COUNT(*) AS pedidos, COALESCE(SUM(COALESCE(o."productsAmount", o."totalAmount")), 0) AS importe
                   FROM marketplace_orders o WHERE o."orderDate" >= $1`,
                [inicioDeMesLima(hoy)],
            ),
        ]);

        const pagoDe = new Map(ultimosPagos.map(p => [p.clientId, p]));
        const liquidacionDe = new Map(liquidaciones.map(l => [l.client.id, l]));
        const diasDe = new Map<string, { dia: string; pedidos: number; importe: number }[]>();
        const ventasPorTiendaSinCliente = new Map<string, { pedidos: number; importe: number }>();
        const idsDeClientes = new Set(ids);
        for (const f of ventas) {
            // El cliente de la venta: el de su tienda; si no tiene tienda (ventas antiguas), el que la registró.
            const cliente = f.tienda ? mapa.clienteDe.get(f.tienda) : (idsDeClientes.has(f.dueno) ? f.dueno : undefined);
            const dato = { dia: f.dia, pedidos: Number(f.pedidos), importe: Number(f.importe) };
            if (cliente) {
                const lista = diasDe.get(cliente) ?? [];
                lista.push(dato);
                diasDe.set(cliente, lista);
            } else if (f.tienda && f.dia.startsWith(mesActual)) {
                const previo = ventasPorTiendaSinCliente.get(f.tienda) ?? { pedidos: 0, importe: 0 };
                ventasPorTiendaSinCliente.set(f.tienda, { pedidos: previo.pedidos + dato.pedidos, importe: previo.importe + dato.importe });
            }
        }
        const suma = (dias: { dia: string; pedidos: number; importe: number }[], pertenece: (dia: string) => boolean) =>
            dias.filter(d => pertenece(d.dia)).reduce((s, d) => ({ pedidos: s.pedidos + d.pedidos, importe: s.importe + d.importe }), { pedidos: 0, importe: 0 });

        const filas = clientes.map(cliente => {
            const perfil = perfilDe.get(cliente.id);
            const dias = diasDe.get(cliente.id) ?? [];
            const ciclo = ciclos.get(cliente.id)!;
            const delMes = suma(dias, d => d.startsWith(mesActual));
            const anteriores = mesesAnteriores.map(m => redondear(suma(dias, d => d.startsWith(m)).importe));
            // Ventas del ciclo de cobro: de su inicio a la fecha de cobro (sin incluirla), sin pasar de hoy.
            const ventasCiclo = redondear(suma(dias, d => d >= ciclo.desde && d < ciclo.hasta).importe);

            const plan = armarPlan(
                perfil ?? { billingModel: 'ninguno', monthlyFee: null, feeFrequency: 'mensual', commissionRate: null, nextDueDate: null, planCurrency: 'PEN', feeIncludesIgv: false, commissionIncludesIgv: false, planStartDate: null },
                redondear(delMes.importe),
                ventasCiclo,
                hoy,
            );
            const propuesta = proponerPlan({
                modelo: plan.modelo,
                cuotaFija: perfil?.monthlyFee ?? null,
                frecuencia: perfil?.feeFrequency ?? 'mensual',
                tasa: perfil?.commissionRate ?? null,
                ventasMes: delMes.importe,
                ventasMesesAnteriores: anteriores,
                moneda: plan.moneda,
                cuotaIncluyeIgv: perfil?.feeIncludesIgv ?? false,
                comisionIncluyeIgv: perfil?.commissionIncludesIgv ?? false,
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
                    mes: redondear(delMes.importe),
                    pedidosMes: delMes.pedidos,
                    mesesAnteriores: mesesAnteriores.map((periodo, i) => ({ periodo, importe: anteriores[i] })),
                },
                plan,
                ultimoPago: pago ? { fecha: pago.paidAt, monto: Number(pago.amount) } : null,
                liquidacionMesAnterior: liq ? { periodo: liq.period, comision: Number(liq.commissionAmount), estado: liq.status } : null,
                propuesta,
                notasDePropuesta: perfil?.proposalNotes ?? null,
                tiendas: mapa.tiendas.filter(t => t.clienteId === cliente.id).map(t => ({ id: t.id, nombre: t.nombre, origen: t.origen })),
            };
        });

        // Primero lo que hay que cobrar o vigilar: vencidos, luego por vencer, luego el resto por ventas.
        const peso = (f: typeof filas[number]) =>
            f.plan.estadoPago === 'vencido' ? 3 : f.plan.estadoPago === 'vence_hoy' ? 2.5 : f.plan.estadoPago === 'por_vencer' ? 2 : 0;
        filas.sort((a, b) => peso(b) - peso(a) || b.plan.cobro.total - a.plan.cobro.total || b.ventas.mes - a.ventas.mes);

        const activos = filas.filter(f => f.estado === 'activo' && f.plan.modelo !== 'ninguno');
        const vencidos = activos.filter(f => f.plan.estadoPago === 'vencido');
        const proximos = activos.filter(f => f.plan.estadoPago === 'por_vencer' || f.plan.estadoPago === 'vence_hoy');
        const total = (lista: typeof filas) => sumarImportes(...lista.flatMap(f => [f.plan.cobro.cuota, f.plan.cobro.comision]));
        const soloCuota = (lista: typeof filas) => sumarImportes(...lista.map(f => f.plan.cobro.cuota));
        const soloComision = (lista: typeof filas) => sumarImportes(...lista.map(f => f.plan.cobro.comision));
        const resumen = (lista: typeof filas) => ({ cantidad: lista.length, ...total(lista) });

        const conexiones = new Map(conexionesPorTienda.map(c => [c.tienda, Number(c.cantidad)]));
        // Tiendas con ventas o canales que no son de ningún cliente: se ven aquí para poder asignarlas.
        const sinAsignar = mapa.tiendas
            .filter(t => !t.clienteId)
            .map(t => ({
                id: t.id,
                nombre: t.nombre,
                dueno: t.duenoEmail,
                ventasMes: redondear(ventasPorTiendaSinCliente.get(t.id)?.importe ?? 0),
                pedidosMes: ventasPorTiendaSinCliente.get(t.id)?.pedidos ?? 0,
                canales: conexiones.get(t.id) ?? 0,
            }))
            .filter(t => t.ventasMes > 0 || t.canales > 0)
            .sort((a, b) => b.ventasMes - a.ventasMes);

        return {
            hoy,
            igvPorcentaje: IGV_PORCENTAJE,
            sinAsignar,
            totales: {
                clientes: filas.length,
                ventasDelMes: redondear(Number(global?.[0]?.importe ?? 0)),
                pedidosDelMes: Number(global?.[0]?.pedidos ?? 0),
                ventasDeClientes: redondear(filas.reduce((s, f) => s + f.ventas.mes, 0)),
                // Lo recurrente: cuotas fijas de clientes activos, llevadas a mes y sin IGV.
                ingresoFijoMensual: redondear(activos.reduce((s, f) => s + mensualizar(f.plan.cobro.cuota?.subtotal ?? 0, f.plan.frecuencia), 0)),
                // Lo que debe ingresar hasta la fecha de cobro de cada cliente: cuota + comisión acumulada, ya con su IGV.
                porIngresar: total(activos),
                porIngresarCuotas: soloCuota(activos),
                porIngresarComisiones: soloComision(activos),
                comisionAcumulada: redondear(activos.reduce((s, f) => s + (f.plan.cobro.comision?.subtotal ?? 0), 0)),
                comisionProyectada: redondear(activos.reduce((s, f) => s + (f.plan.comisionProyectada != null ? desglosarIgv(f.plan.comisionProyectada, f.plan.comisionIncluyeIgv).subtotal : (f.plan.cobro.comision?.subtotal ?? 0)), 0)),
                cobradoEsteMes: Number(cobradoMes?.total ?? 0),
                vencidos: resumen(vencidos),
                proximos: resumen(proximos),
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
        const cero = { subtotal: 0, igv: 0, total: 0 };
        return {
            hoy,
            igvPorcentaje: IGV_PORCENTAJE,
            sinAsignar: [] as { id: string; nombre: string; dueno: string; ventasMes: number; pedidosMes: number; canales: number }[],
            totales: {
                clientes: 0, ventasDelMes: 0, pedidosDelMes: 0, ventasDeClientes: 0, ingresoFijoMensual: 0,
                porIngresar: cero, porIngresarCuotas: cero, porIngresarComisiones: cero,
                comisionAcumulada: 0, comisionProyectada: 0, cobradoEsteMes: 0,
                vencidos: { cantidad: 0, ...cero }, proximos: { cantidad: 0, ...cero }, sinPlan: 0,
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

    // ─────────────────────────────────────────────────────────────
    // Agencia: todo lo de un cliente, como lo ve él
    // ─────────────────────────────────────────────────────────────

    /**
     * Lo mismo que ve el cliente en su dashboard, para que el superadmin lo
     * revise a detalle. Un cliente puede tener varias tiendas: se elige una
     * (la primera si no se indica) y se devuelve la lista para cambiar.
     */
    async getClientDetail(clientId: string, storeId?: string) {
        const cliente = await this.users.findOne({ where: { id: clientId } });
        if (!cliente) throw new NotFoundException('Cliente no encontrado');

        const { tiendas: todas } = await this.clientStores.mapa();
        const tiendas = todas.filter(t => t.clienteId === clientId);
        const elegida = tiendas.find(t => t.id === storeId) ?? tiendas[0];
        if (!elegida) {
            return { tiendas: [], tiendaId: null, resumen: null, insights: null, plan: await this.planDelCliente(clientId, hoyEnLima()) };
        }

        const scope = { userId: clientId, storeId: elegida.id };
        const [resumen, insights] = await Promise.all([this.summary.getSummary(scope), this.getInsights(scope)]);
        return {
            tiendas: tiendas.map(t => ({ id: t.id, nombre: t.nombre })),
            tiendaId: elegida.id,
            resumen,
            insights,
            plan: insights.plan,
        };
    }

    // ─────────────────────────────────────────────────────────────
    // Agencia: asignar tiendas a clientes
    // ─────────────────────────────────────────────────────────────

    /** Todas las tiendas, con su dueño, a qué cliente pertenecen y de qué manera, y cuánto vendieron este mes. */
    async getStoreAssignments() {
        const [{ tiendas }, ventas, conexiones] = await Promise.all([
            this.clientStores.mapa(),
            this.orders.query(
                `SELECT o."storeId" AS tienda, COUNT(*) AS pedidos, COALESCE(SUM(COALESCE(o."productsAmount", o."totalAmount")), 0) AS importe
                   FROM marketplace_orders o WHERE o."storeId" IS NOT NULL AND o."orderDate" >= $1 GROUP BY o."storeId"`,
                [inicioDeMesLima(hoyEnLima())],
            ),
            this.orders.query(`SELECT "storeId" AS tienda, COUNT(*) AS cantidad FROM marketplace_connections WHERE "storeId" IS NOT NULL GROUP BY "storeId"`),
        ]);
        const ventasDe = new Map<string, { pedidos: number; importe: number }>(ventas.map((v: any) => [v.tienda, { pedidos: Number(v.pedidos), importe: Number(v.importe) }]));
        const canalesDe = new Map<string, number>(conexiones.map((c: any) => [c.tienda, Number(c.cantidad)]));
        return tiendas.map(t => ({
            id: t.id,
            nombre: t.nombre,
            dueno: t.duenoEmail,
            clienteId: t.clienteId,
            origen: t.origen,
            ventasMes: redondear(ventasDe.get(t.id)?.importe ?? 0),
            pedidosMes: ventasDe.get(t.id)?.pedidos ?? 0,
            canales: canalesDe.get(t.id) ?? 0,
        }));
    }

    async assignStore(storeId: string, clientId: string | null) {
        return this.clientStores.asignar(storeId, clientId);
    }

}
