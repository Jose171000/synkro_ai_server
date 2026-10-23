import { agruparVentas, direccionDePublicacion } from './ganadoras';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { MarketplaceOrder } from '../sync/entities/marketplace-order.entity';
import { ListingLink } from '../sync/entities/listing-link.entity';
import { SyncChangeRequest } from '../sync/entities/sync-change-request.entity';
import { Product } from '../products/entities/product.entity';
import { Payment } from '../admin/entities/payment.entity';
import { Store } from '../stores/entities/store.entity';
import { CreatePaymentDto } from '../admin/dto/create-payment.dto';
import { DashboardService } from './dashboard.service';
import { UpdateStorePlanDto } from './dto/update-store-plan.dto';
import {
    avanzarVencimiento,
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

/** Los datos del plan que lleva cada tienda. */
type PlanDeTienda = Pick<
    Store,
    'billingModel' | 'monthlyFee' | 'feeFrequency' | 'commissionRate' | 'nextDueDate' | 'planCurrency' | 'feeIncludesIgv' | 'commissionIncludesIgv' | 'planStartDate'
>;

export function armarPlan(plan: PlanDeTienda, ventasMes: number, ventasCiclo: number, hoy: string): ResumenDePlan {
    const cobraCuota = plan.billingModel === 'fijo' || plan.billingModel === 'mixto';
    const cobraComision = plan.billingModel === 'comision' || plan.billingModel === 'mixto';
    const ciclo = cicloDeCobro(plan.nextDueDate, plan.feeFrequency, plan.planStartDate, hoy);
    const comision = cobraComision ? comisionDelCiclo(ventasCiclo, plan.commissionRate, ciclo, hoy) : { acumulada: 0, proyectada: null };
    // La fecha de cobro vale para cualquier plan con algo que cobrar: cuota, comisión o ambos.
    const pago = plan.billingModel !== 'ninguno' ? estadoDePago(plan.nextDueDate, hoy) : null;

    const cuota = cobraCuota ? desglosarIgv(plan.monthlyFee, !!plan.feeIncludesIgv) : null;
    const comisionImporte = cobraComision ? desglosarIgv(comision.acumulada, !!plan.commissionIncludesIgv) : null;

    return {
        modelo: plan.billingModel as ModeloDeCobro,
        moneda: plan.planCurrency || 'PEN',
        frecuencia: plan.feeFrequency,
        cuotaFija: cobraCuota ? plan.monthlyFee : null,
        cuotaIncluyeIgv: !!plan.feeIncludesIgv,
        tasa: cobraComision ? plan.commissionRate : null,
        comisionIncluyeIgv: !!plan.commissionIncludesIgv,
        proximoPago: plan.billingModel !== 'ninguno' ? plan.nextDueDate : null,
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
 * cuánto vende cada tienda (cada tienda es un cliente), cuánto y cuándo hay que
 * cobrarle y qué proponerle. Todo sale de datos que el sistema ya tiene.
 */
@Injectable()
export class DashboardInsightsService {
    constructor(
        @InjectRepository(MarketplaceOrder) private readonly orders: Repository<MarketplaceOrder>,
        @InjectRepository(ListingLink) private readonly listings: Repository<ListingLink>,
        @InjectRepository(SyncChangeRequest) private readonly changes: Repository<SyncChangeRequest>,
        @InjectRepository(Product) private readonly products: Repository<Product>,
        @InjectRepository(Payment) private readonly payments: Repository<Payment>,
        @InjectRepository(Store) private readonly stores: Repository<Store>,
        private readonly summary: DashboardService,
    ) { }

    // ─────────────────────────────────────────────────────────────
    // Tienda: lo que ve su dueño
    // ─────────────────────────────────────────────────────────────

    /**
     * `verPlan`: el plan y los cobros solo los ve quien es dueño de la tienda
     * (o un superadmin); un editor o lector de la tienda no.
     */
    async getInsights(scope: { userId: string; storeId: string; verPlan?: boolean }) {
        const hoy = hoyEnLima();
        const [ganadoras, porDespachar, ventasDiarias, pendientesDeRevision, plan] = await Promise.all([
            this.ganadoras(scope),
            this.porDespachar(scope.storeId),
            this.ventasDiarias(scope.storeId),
            this.changes.count({ where: { store: { id: scope.storeId }, status: 'pending' } }),
            scope.verPlan === false ? Promise.resolve(null) : this.planDeLaTienda(scope.storeId, hoy),
        ]);
        return { ganadoras, porDespachar, ventasDiarias, pendientesDeRevision, plan };
    }

    /**
     * Lo que más se vende en los últimos 30 días. Cada ganadora lleva sus días
     * de stock al ritmo actual: una que se vende bien y se está acabando es la
     * que más conviene reponer y no dejar de publicar.
     */
    private async ganadoras(scope: { userId: string; storeId: string }) {
        // Por SKU y canal: de ahí sale el canal donde más ingresó cada producto.
        const crudas: { sku: string; title: string; marketplace: string; unidades: string; importe: string }[] = await this.orders.query(
            `SELECT it->>'sku' AS sku,
                    MAX(it->>'title') AS title,
                    o.marketplace AS marketplace,
                    SUM(COALESCE((it->>'quantity')::numeric, 1)) AS unidades,
                    SUM(COALESCE((it->>'quantity')::numeric, 1) * COALESCE((it->>'unitPrice')::numeric, 0)) AS importe
               FROM marketplace_orders o,
                    jsonb_array_elements(CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::jsonb END) it
              WHERE o."storeId" = $1
                AND o."orderDate" >= NOW() - INTERVAL '30 days'
                AND COALESCE(it->>'sku', '') <> ''
              GROUP BY it->>'sku', o.marketplace`,
            [scope.storeId],
        );
        // Los 10 que más ingresaron y los 10 que más unidades vendieron: la pantalla ordena por cualquiera de los dos.
        const ventas = agruparVentas(crudas.map(f => ({ sku: f.sku, title: f.title, marketplace: f.marketplace, unidades: Number(f.unidades), importe: Number(f.importe) })), 10);
        if (!ventas.length) return [];
        const filas = ventas.map(v => ({ sku: v.sku, title: v.title, unidades: String(v.unidades), importe: String(v.importe), canal: v.canal, canales: v.canales }));

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
        const enlacesPlanos = enlaces.map(e => ({ productId: e.product.id, marketplace: e.marketplace, permalink: e.permalink ?? null, syncStatus: e.syncStatus }));
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
                /** Canal donde más ingresó este producto (con su porcentaje) y todos los canales donde se vendió. */
                canal: f.canal ? { ...f.canal, url: producto ? direccionDePublicacion(enlacesPlanos, producto.id, f.canal.marketplace) : null } : null,
                canales: f.canales.map(c => ({ ...c, url: producto ? direccionDePublicacion(enlacesPlanos, producto.id, c.marketplace) : null })),
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

    /** Precio de los productos vendidos por una tienda en un rango: es la base de su comisión. */
    private async ventasDeLaTienda(storeId: string, desde: Date, hasta?: Date): Promise<number> {
        const qb = this.orders
            .createQueryBuilder('o')
            .select('COALESCE(SUM(COALESCE(o."productsAmount", o."totalAmount")), 0)', 'importe')
            .where('o."storeId" = :storeId', { storeId })
            .andWhere('o."orderDate" >= :desde', { desde });
        if (hasta) qb.andWhere('o."orderDate" < :hasta', { hasta });
        const fila = await qb.getRawOne();
        return Number(fila?.importe ?? 0);
    }

    /** El plan de la tienda: solo existe si la agencia le definió uno. */
    private async planDeLaTienda(storeId: string, hoy: string) {
        const tienda = await this.stores.findOne({ where: { id: storeId } });
        if (!tienda || tienda.billingModel === 'ninguno') return null;

        const desdeEsteMes = inicioDeMesLima(hoy);
        const ciclo = cicloDeCobro(tienda.nextDueDate, tienda.feeFrequency, tienda.planStartDate, hoy);
        const [ventasMes, ventasMesPasado, ventasCiclo, ultimoPago] = await Promise.all([
            this.ventasDeLaTienda(storeId, desdeEsteMes),
            this.ventasDeLaTienda(storeId, inicioDeMesLima(hoy, -1), desdeEsteMes),
            this.ventasDeLaTienda(storeId, limaMedianoche(ciclo.desde), limaMedianoche(ciclo.hasta)),
            this.payments.findOne({ where: { store: { id: storeId } }, order: { paidAt: 'DESC' } }),
        ]);

        return {
            ...armarPlan(tienda, ventasMes, ventasCiclo, hoy),
            ventasMesAnterior: ventasMesPasado,
            ultimoPago: ultimoPago ? { fecha: ultimoPago.paidAt, monto: Number(ultimoPago.amount), concepto: ultimoPago.concept } : null,
        };
    }

    private mesDe(hoy: string, desplazamiento: number): string {
        const [a, m] = hoy.split('-').map(Number);
        const d = new Date(Date.UTC(a, m - 1 + desplazamiento, 1));
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    }

    // ─────────────────────────────────────────────────────────────
    // Agencia: todas las tiendas (cada tienda es un cliente)
    // ─────────────────────────────────────────────────────────────

    /**
     * Control de la cartera: cuánto vende cada tienda, qué se le cobra, cuándo
     * vence y qué proponerle. Las cifras salen de consultas agrupadas, no de una
     * por tienda, para que no se degrade al crecer la cartera.
     */
    async getAgency() {
        const hoy = hoyEnLima();
        const mesActual = hoy.slice(0, 7);
        const mesesAnteriores = [-1, -2, -3].map(d => this.mesDe(hoy, d));

        const tiendas = await this.stores.find({ relations: { owner: true }, order: { createdAt: 'DESC' } });
        if (!tiendas.length) return this.agenciaVacia(hoy);

        // Ciclo de cobro de cada tienda; las ventas se leen desde el más antiguo de todos.
        const ciclos = new Map(tiendas.map(t => [t.id, cicloDeCobro(t.nextDueDate, t.feeFrequency, t.planStartDate, hoy)] as const));
        const desdeMes = `${mesesAnteriores[mesesAnteriores.length - 1]}-01`;
        const desdeVentas = [desdeMes, ...[...ciclos.values()].map(c => c.desde)].sort()[0];

        const [ventas, conexiones, ultimosPagos, cobradoMes, global] = await Promise.all([
            // Ventas por tienda y DÍA (hora de Lima): de ahí salen el mes, los anteriores y el ciclo de cobro de cada una.
            this.orders.query(
                `SELECT o."storeId" AS tienda,
                        to_char(o."orderDate" AT TIME ZONE 'America/Lima', 'YYYY-MM-DD') AS dia,
                        COUNT(*) AS pedidos,
                        COALESCE(SUM(COALESCE(o."productsAmount", o."totalAmount")), 0) AS importe
                   FROM marketplace_orders o
                  WHERE o."storeId" IS NOT NULL AND o."orderDate" >= $1
                  GROUP BY o."storeId", dia`,
                [limaMedianoche(desdeVentas)],
            ),

            this.orders.query(`SELECT "storeId" AS tienda, marketplace, status FROM marketplace_connections WHERE "storeId" IS NOT NULL`),

            // El último pago de cada tienda (DISTINCT ON necesita las columnas en crudo para traer el storeId).
            this.payments
                .createQueryBuilder('p')
                .select(['p."storeId" AS "storeId"', 'p."paidAt" AS "paidAt"', 'p.amount AS amount'])
                .distinctOn(['p."storeId"'])
                .where('p."storeId" IS NOT NULL')
                .orderBy('p."storeId"')
                .addOrderBy('p."paidAt"', 'DESC')
                .getRawMany<{ storeId: string; paidAt: string; amount: string }>(),

            this.payments
                .createQueryBuilder('p')
                .select('COALESCE(SUM(p.amount), 0)', 'total')
                .where('"p"."paidAt" >= :desde', { desde: `${mesActual}-01` })
                .getRawOne(),

            // El superadmin ve TODO lo que se vendió este mes, de cualquier tienda.
            this.orders.query(
                `SELECT COUNT(*) AS pedidos, COALESCE(SUM(COALESCE(o."productsAmount", o."totalAmount")), 0) AS importe
                   FROM marketplace_orders o WHERE o."orderDate" >= $1`,
                [inicioDeMesLima(hoy)],
            ),
        ]);

        const pagoDe = new Map(ultimosPagos.map(p => [p.storeId, p]));
        const diasDe = new Map<string, { dia: string; pedidos: number; importe: number }[]>();
        for (const f of ventas) {
            const lista = diasDe.get(f.tienda) ?? [];
            lista.push({ dia: f.dia, pedidos: Number(f.pedidos), importe: Number(f.importe) });
            diasDe.set(f.tienda, lista);
        }
        const canalesDe = new Map<string, { marketplace: string; status: string }[]>();
        for (const c of conexiones) {
            const lista = canalesDe.get(c.tienda) ?? [];
            lista.push({ marketplace: c.marketplace, status: c.status });
            canalesDe.set(c.tienda, lista);
        }
        const suma = (dias: { dia: string; pedidos: number; importe: number }[], pertenece: (dia: string) => boolean) =>
            dias.filter(d => pertenece(d.dia)).reduce((s, d) => ({ pedidos: s.pedidos + d.pedidos, importe: s.importe + d.importe }), { pedidos: 0, importe: 0 });

        const filas = tiendas.map(tienda => {
            const dias = diasDe.get(tienda.id) ?? [];
            const ciclo = ciclos.get(tienda.id)!;
            const delMes = suma(dias, d => d.startsWith(mesActual));
            const anteriores = mesesAnteriores.map(m => redondear(suma(dias, d => d.startsWith(m)).importe));
            // Ventas del ciclo de cobro: de su inicio a la fecha de cobro (sin incluirla).
            const ventasCiclo = redondear(suma(dias, d => d >= ciclo.desde && d < ciclo.hasta).importe);

            const plan = armarPlan(tienda, redondear(delMes.importe), ventasCiclo, hoy);
            const propuesta = proponerPlan({
                modelo: plan.modelo,
                cuotaFija: tienda.monthlyFee,
                frecuencia: tienda.feeFrequency,
                tasa: tienda.commissionRate,
                ventasMes: delMes.importe,
                ventasMesesAnteriores: anteriores,
                moneda: plan.moneda,
                cuotaIncluyeIgv: tienda.feeIncludesIgv,
                comisionIncluyeIgv: tienda.commissionIncludesIgv,
            });
            const pago = pagoDe.get(tienda.id);
            const canales = canalesDe.get(tienda.id) ?? [];

            return {
                id: tienda.id,
                nombre: tienda.name,
                /** Correo de quien creó la tienda: no siempre es el cliente. */
                dueno: tienda.owner?.email ?? '',
                canales,
                canalesCaidos: canales.filter(c => c.status !== 'active').length,
                ventas: {
                    mes: redondear(delMes.importe),
                    pedidosMes: delMes.pedidos,
                    mesesAnteriores: mesesAnteriores.map((periodo, i) => ({ periodo, importe: anteriores[i] })),
                },
                plan,
                ultimoPago: pago ? { fecha: pago.paidAt, monto: Number(pago.amount) } : null,
                propuesta,
                notasDePropuesta: tienda.proposalNotes ?? null,
            };
        });

        // Primero lo que hay que cobrar o vigilar: vencidos, luego por vencer, luego el resto por lo que cobrar y vender.
        const peso = (f: typeof filas[number]) =>
            f.plan.estadoPago === 'vencido' ? 3 : f.plan.estadoPago === 'vence_hoy' ? 2.5 : f.plan.estadoPago === 'por_vencer' ? 2 : 0;
        filas.sort((a, b) => peso(b) - peso(a) || b.plan.cobro.total - a.plan.cobro.total || b.ventas.mes - a.ventas.mes);

        const conPlan = filas.filter(f => f.plan.modelo !== 'ninguno');
        const vencidos = conPlan.filter(f => f.plan.estadoPago === 'vencido');
        const proximos = conPlan.filter(f => f.plan.estadoPago === 'por_vencer' || f.plan.estadoPago === 'vence_hoy');
        const total = (lista: typeof filas) => sumarImportes(...lista.flatMap(f => [f.plan.cobro.cuota, f.plan.cobro.comision]));
        const soloCuota = (lista: typeof filas) => sumarImportes(...lista.map(f => f.plan.cobro.cuota));
        const soloComision = (lista: typeof filas) => sumarImportes(...lista.map(f => f.plan.cobro.comision));
        const resumen = (lista: typeof filas) => ({ cantidad: lista.length, ...total(lista) });

        return {
            hoy,
            igvPorcentaje: IGV_PORCENTAJE,
            totales: {
                clientes: filas.length,
                ventasDelMes: redondear(Number(global?.[0]?.importe ?? 0)),
                pedidosDelMes: Number(global?.[0]?.pedidos ?? 0),
                // Lo recurrente: cuotas fijas llevadas a mes y sin IGV.
                ingresoFijoMensual: redondear(conPlan.reduce((s, f) => s + mensualizar(f.plan.cobro.cuota?.subtotal ?? 0, f.plan.frecuencia), 0)),
                // Lo que debe ingresar hasta la fecha de cobro de cada cliente: cuota + comisión acumulada, ya con su IGV.
                porIngresar: total(conPlan),
                porIngresarCuotas: soloCuota(conPlan),
                porIngresarComisiones: soloComision(conPlan),
                comisionAcumulada: redondear(conPlan.reduce((s, f) => s + (f.plan.cobro.comision?.subtotal ?? 0), 0)),
                comisionProyectada: redondear(conPlan.reduce((s, f) => s + (f.plan.comisionProyectada != null ? desglosarIgv(f.plan.comisionProyectada, f.plan.comisionIncluyeIgv).subtotal : (f.plan.cobro.comision?.subtotal ?? 0)), 0)),
                cobradoEsteMes: Number(cobradoMes?.total ?? 0),
                vencidos: resumen(vencidos),
                proximos: resumen(proximos),
                sinPlan: filas.length - conPlan.length,
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
            totales: {
                clientes: 0, ventasDelMes: 0, pedidosDelMes: 0, ingresoFijoMensual: 0,
                porIngresar: cero, porIngresarCuotas: cero, porIngresarComisiones: cero,
                comisionAcumulada: 0, comisionProyectada: 0, cobradoEsteMes: 0,
                vencidos: { cantidad: 0, ...cero }, proximos: { cantidad: 0, ...cero }, sinPlan: 0,
                porModelo: { fijo: 0, comision: 0, mixto: 0 },
            },
            clientes: [] as any[],
        };
    }

    // ─────────────────────────────────────────────────────────────
    // Agencia: una tienda a detalle, su plan y sus pagos
    // ─────────────────────────────────────────────────────────────

    /** Lo mismo que ve el dueño de la tienda en su dashboard, para revisarlo a detalle. */
    async getClientDetail(storeId: string) {
        const tienda = await this.stores.findOne({ where: { id: storeId }, relations: { owner: true } });
        if (!tienda) throw new NotFoundException('Tienda no encontrada');

        const scope = { userId: tienda.owner.id, storeId, verPlan: true };
        const [resumen, insights, pagos] = await Promise.all([
            this.summary.getSummary(scope),
            this.getInsights(scope),
            this.payments.find({ where: { store: { id: storeId } }, order: { paidAt: 'DESC' }, take: 8 }),
        ]);
        return {
            tienda: { id: tienda.id, nombre: tienda.name, dueno: tienda.owner.email },
            resumen,
            insights,
            plan: insights.plan,
            pagos: pagos.map(p => ({ id: p.id, fecha: p.paidAt, monto: Number(p.amount), concepto: p.concept, tipo: p.type })),
        };
    }

    /** Guarda el plan comercial de una tienda. */
    async updateStorePlan(storeId: string, dto: UpdateStorePlanDto) {
        const tienda = await this.stores.findOne({ where: { id: storeId } });
        if (!tienda) throw new NotFoundException('Tienda no encontrada');
        // Solo los campos del plan; nunca el dueño ni el resto de la tienda.
        const campos: (keyof UpdateStorePlanDto)[] = [
            'billingModel', 'monthlyFee', 'feeFrequency', 'commissionRate', 'nextDueDate', 'planCurrency',
            'feeIncludesIgv', 'commissionIncludesIgv', 'planStartDate', 'proposalNotes',
        ];
        for (const campo of campos) {
            if (dto[campo] !== undefined) (tienda as any)[campo] = dto[campo];
        }
        await this.stores.save(tienda);
        return { id: tienda.id };
    }

    /** Registra un pago de la tienda; si es recurrente, adelanta solo su próxima fecha de cobro. */
    async registerStorePayment(storeId: string, dto: CreatePaymentDto) {
        const tienda = await this.stores.findOne({ where: { id: storeId }, relations: { owner: true } });
        if (!tienda) throw new NotFoundException('Tienda no encontrada');

        const pago = await this.payments.save(this.payments.create({
            ...dto,
            currency: dto.currency || tienda.planCurrency || 'PEN',
            store: { id: storeId } as any,
            client: { id: tienda.owner.id } as any,
        }));

        if (dto.type === 'recurrente' && tienda.billingModel !== 'ninguno') {
            tienda.nextDueDate = avanzarVencimiento(tienda.nextDueDate, dto.paidAt.slice(0, 10), dto.frequency ?? tienda.feeFrequency);
            await this.stores.save(tienda);
        }
        return { id: pago.id, proximoPago: tienda.nextDueDate };
    }
}
