import { z } from 'zod';
import type { Repository } from 'typeorm';
import type Redis from 'ioredis';
import type { AccesoMcp, AccesoPlataforma, ApiKeysService } from './api-keys.service';
import type { PermisoPlataforma } from './permisos-plataforma';
import { HERRAMIENTAS, MAX_POR_PAGINA, ServiciosMcp } from './mcp-tools';
import type { AdminService } from '../admin/admin.service';
import type { BillingService } from '../admin/billing.service';
import type { SignupsService } from '../admin/signups.service';
import type { DashboardInsightsService } from '../dashboard/dashboard-insights.service';
import type { Store } from '../stores/entities/store.entity';
import { diagnosticarRedis } from '../common/redis-diagnostico';

export interface ServiciosPlataforma {
    admin: AdminService;
    insights: DashboardInsightsService;
    billing: BillingService;
    signups: SignupsService;
    stores: Repository<Store>;
    keys: ApiKeysService;
    redis: Redis;
}

/**
 * Una herramienta del MCP de plataforma. Como en las de tienda, `permiso` es obligatorio y una prueba (`platform-tools.spec.ts`)
 * fija la tabla completa. Todas son de SOLO LECTURA: ninguna modifica clientes, pagos, cuentas ni Redis.
 */
export interface HerramientaPlataforma {
    name: string;
    title: string;
    description: string;
    permiso: PermisoPlataforma;
    input: z.ZodRawShape;
    ejecutar(servicios: ServiciosPlataforma, acceso: AccesoPlataforma, args: any): Promise<unknown>;
}

const ver = (a: AccesoPlataforma, p: PermisoPlataforma) => a.permissions.includes(p);

/** Un cliente tal como lo ve el MCP: sin contraseña, teléfono, enlaces a hojas de cálculo ni nada de acceso. El dinero, solo con `finanzas.ver`. */
export function resumenDeCliente(c: any, conFinanzas: boolean) {
    const p = c.profile ?? null;
    return {
        id: c.id,
        email: c.email,
        name: `${c.name ?? ''} ${c.lastName ?? ''}`.trim(),
        company: c.nameCompany ?? null,
        country: c.country ?? null,
        role: c.role,
        active: c.isActive,
        approval: c.approvalStatus,
        createdAt: c.createdAt,
        teamOnly: c.teamOnly ?? false,
        teamOf: (c.teamOf ?? []).map((t: any) => ({ store: t.storeName, role: t.role })),
        profile: p
            ? {
                businessName: p.businessName ?? null,
                ruc: p.ruc ?? null,
                clientType: p.clientType ?? null,
                status: p.status ?? null,
                ...(conFinanzas ? {
                    billingModel: p.billingModel, monthlyFee: p.monthlyFee, feeFrequency: p.feeFrequency, commissionRate: p.commissionRate,
                    nextDueDate: p.nextDueDate, planCurrency: p.planCurrency,
                } : {}),
            }
            : null,
        stats: c.stats
            ? {
                products: c.stats.products,
                publishedListings: c.stats.publishedListings,
                connectedMarketplaces: c.stats.connectedMarketplaces,
                ...(conFinanzas ? { totalPaid: c.stats.totalPaid, lastPaymentAt: c.stats.lastPaymentAt } : {}),
            }
            : undefined,
    };
}

const periodo = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Usa el formato AAAA-MM').describe('El periodo, como AAAA-MM.');

export const HERRAMIENTAS_PLATAFORMA: HerramientaPlataforma[] = [
    {
        name: 'listar_clientes',
        title: 'Listar clientes',
        description: 'Cuentas de la plataforma con sus tiendas, canales conectados y cuántos productos tienen. Los pagos y el plan, solo si la clave tiene finanzas.',
        permiso: 'clientes.ver',
        input: {
            search: z.string().max(100).optional().describe('Nombre, correo o empresa.'),
            incluirEquipo: z.boolean().optional().describe('true para incluir también a quienes solo son parte del equipo de otra tienda.'),
            limit: z.number().int().min(1).max(100).optional().describe('Máximo 100 (por defecto 50).'),
        },
        async ejecutar({ admin }, a, args) {
            const texto = String(args.search ?? '').trim().toLowerCase();
            const todos: any[] = await admin.getClients();
            const filtrados = todos
                .filter((c) => args.incluirEquipo || !c.teamOnly)
                .filter((c) => !texto || [c.email, c.name, c.lastName, c.nameCompany, c.profile?.businessName].some((v) => String(v ?? '').toLowerCase().includes(texto)));
            return {
                total: filtrados.length,
                clientes: filtrados.slice(0, args.limit ?? 50).map((c) => resumenDeCliente(c, ver(a, 'finanzas.ver'))),
            };
        },
    },
    {
        name: 'ver_cliente',
        title: 'Ver un cliente',
        description: 'Una cuenta a detalle. Sus pagos, solo si la clave tiene finanzas.',
        permiso: 'clientes.ver',
        input: { id: z.string().uuid().describe('El id del cliente (lo da listar_clientes).') },
        async ejecutar({ admin }, a, args) {
            const c: any = await admin.getClientDetail(args.id);
            const conFinanzas = ver(a, 'finanzas.ver');
            return {
                ...resumenDeCliente(c, conFinanzas),
                ...(conFinanzas ? { payments: (c.payments ?? []).slice(0, 50).map((p: any) => ({ id: p.id, date: p.paidAt, amount: Number(p.amount), currency: p.currency, type: p.type, concept: p.concept })) } : {}),
            };
        },
    },
    {
        name: 'listar_tiendas',
        title: 'Listar tiendas',
        description: 'Todas las tiendas con su id y su dueño. El id sirve para las herramientas «tienda_…».',
        permiso: 'clientes.ver',
        input: { search: z.string().max(100).optional().describe('Nombre de la tienda o correo del dueño.') },
        async ejecutar({ stores }, _a, args) {
            const texto = String(args.search ?? '').trim().toLowerCase();
            const filas = await stores.find({ relations: { owner: true }, order: { name: 'ASC' }, select: { id: true, name: true, createdAt: true, owner: { id: true, email: true } } });
            return filas
                .filter((s) => !texto || s.name.toLowerCase().includes(texto) || String(s.owner?.email ?? '').toLowerCase().includes(texto))
                .map((s) => ({ id: s.id, name: s.name, owner: s.owner?.email ?? null, createdAt: s.createdAt }));
        },
    },
    {
        name: 'solicitudes_de_registro',
        title: 'Solicitudes de registro',
        description: 'Personas que pidieron una cuenta y esperan aprobación (o fueron rechazadas). Solo lectura: no aprueba ni rechaza.',
        permiso: 'clientes.ver',
        input: { estado: z.enum(['pending', 'rejected']).optional().describe('Por defecto, pendientes.') },
        async ejecutar({ signups }, _a, args) {
            const r: any = await signups.list(args.estado ?? 'pending');
            // Sin el teléfono: para contactar a alguien se usa su correo.
            return { conteo: r.conteo, solicitudes: r.solicitudes.map(({ telefono: _t, ...resto }: any) => resto) };
        },
    },
    {
        name: 'cartera_agencia',
        title: 'Cartera de la agencia',
        description: 'Por cliente: ventas del mes y de los tres anteriores, plan comercial, próximo pago, comisión acumulada, último pago y cobros vencidos o próximos.',
        permiso: 'finanzas.ver',
        input: {},
        async ejecutar({ insights }) {
            return insights.getAgency();
        },
    },
    {
        name: 'ver_tienda_en_cartera',
        title: 'Una tienda en la cartera',
        description: 'Lo mismo que ve el dueño en su dashboard, más su plan y sus últimos pagos.',
        permiso: 'finanzas.ver',
        input: { tiendaId: z.string().uuid().describe('El id de la tienda (lo da listar_tiendas).') },
        async ejecutar({ insights }, _a, args) {
            return insights.getClientDetail(args.tiendaId);
        },
    },
    {
        name: 'resumen_financiero',
        title: 'Resumen financiero',
        description: 'Total histórico cobrado, ingresos del mes, ingreso mensual recurrente (MRR) e ingresos por mes.',
        permiso: 'finanzas.ver',
        input: {},
        async ejecutar({ admin }) {
            return admin.getFinanceSummary();
        },
    },
    {
        name: 'cobros_del_periodo',
        title: 'Cobros del periodo',
        description: 'Todos los clientes del periodo con su liquidación (ventas, comisión, estado), tengan o no cargada: sirve para ver a quién falta facturar.',
        permiso: 'finanzas.ver',
        input: { periodo },
        async ejecutar({ billing }, _a, args) {
            return billing.getPeriod(args.periodo);
        },
    },
    {
        name: 'tendencia_de_cobros',
        title: 'Tendencia de cobros',
        description: 'Ventas y comisiones por mes de los últimos 12 periodos.',
        permiso: 'finanzas.ver',
        input: {},
        async ejecutar({ billing }) {
            return billing.getTrend();
        },
    },
    {
        name: 'estado_del_sistema',
        title: 'Estado del sistema',
        description: 'Qué ocupa Redis: memoria, copias en disco, trabajos por cola y reparto por tipo de dato. Solo lectura.',
        permiso: 'sistema.ver',
        input: {},
        async ejecutar({ redis }) {
            return diagnosticarRedis(redis);
        },
    },
    {
        name: 'listar_claves_mcp',
        title: 'Claves del MCP',
        description: 'Todas las claves del MCP (de tienda y de plataforma): quién la creó, de qué tienda, permisos, estado y último uso. Nunca la clave. Para revocar, usa la pantalla de superadmin.',
        permiso: 'sistema.ver',
        input: {
            tipo: z.enum(['store', 'platform']).optional(),
            estado: z.enum(['activa', 'revocada', 'caducada']).optional(),
        },
        async ejecutar({ keys }, a, args) {
            return keys.listarTodas(a.userId, { kind: args.tipo, estado: args.estado });
        },
    },
];

/** Las herramientas de tienda, ofrecidas a nivel plataforma: las mismas, con `tiendaId` para elegir de cuál. Se llaman `tienda_…`. */
export interface HerramientaDeTiendaEnPlataforma {
    name: string;
    title: string;
    description: string;
    permisoDeTienda: string;
    input: z.ZodRawShape;
    original: (typeof HERRAMIENTAS)[number];
}

export const HERRAMIENTAS_DE_TIENDA_EN_PLATAFORMA: HerramientaDeTiendaEnPlataforma[] = HERRAMIENTAS.map((h) => ({
    name: `tienda_${h.name}`,
    title: `${h.title} (de una tienda)`,
    description: `${h.description} Elige la tienda con tiendaId (lo da listar_tiendas).`,
    permisoDeTienda: h.permiso,
    input: { tiendaId: z.string().uuid().describe('El id de la tienda (lo da listar_tiendas).'), ...h.input },
    original: h,
}));

export type { ServiciosMcp, AccesoMcp };
export { MAX_POR_PAGINA };
