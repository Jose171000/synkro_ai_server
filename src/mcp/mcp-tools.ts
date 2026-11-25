import { z } from 'zod';
import type { Permiso } from '../stores/permissions';
import type { AccesoMcp } from './api-keys.service';
import type { ProductsService } from '../products/products.service';
import type { OrdersQueryService } from '../sync/orders-query.service';
import type { ProductOverviewService } from '../sync/product-overview.service';
import type { DashboardService } from '../dashboard/dashboard.service';
import type { ReportsService } from '../reports/reports.service';
import type { ChangeRequestsService } from '../sync/change-requests.service';
import type { ProductGroupsService } from '../products/product-groups.service';
import type { UploadService } from '../upload/upload.service';

/** Los servicios que usan las herramientas: los mismos que usa la app, sin copias. */
export interface ServiciosMcp {
    products: ProductsService;
    orders: OrdersQueryService;
    overview: ProductOverviewService;
    dashboard: DashboardService;
    reports: ReportsService;
    changes: ChangeRequestsService;
    /** Solo los usan las herramientas de escritura. */
    groups: ProductGroupsService;
    upload: UploadService;
}

/**
 * Una herramienta del MCP. `permiso` es OBLIGATORIO y es el mismo permiso que la app exige para esa información: una
 * herramienta sin él no compila, y la prueba `mcp-tools.spec.ts` fija la tabla completa. Las de este archivo son de solo
 * lectura; las que cambian datos están en `mcp-write-tools.ts`.
 */
export interface HerramientaMcp {
    name: string;
    title: string;
    description: string;
    permiso: Permiso;
    input: z.ZodRawShape;
    ejecutar(servicios: ServiciosMcp, acceso: AccesoMcp, args: any): Promise<unknown>;
}

/** Lo máximo que se devuelve por llamada: una respuesta enorme saturaría el contexto del modelo que la lee. */
export const MAX_CARACTERES = 60_000;
export const MAX_POR_PAGINA = 50;

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa el formato AAAA-MM-DD').optional();
const estadoDeVenta = z.string().max(80).optional().describe('pendiente, enviado, entregado, cancelado o devuelto (varios, separados por coma). Sin valor, todas.');
const tope = (por: number) => z.number().int().min(1).max(MAX_POR_PAGINA).optional().describe(`Cuántos devolver (máximo ${MAX_POR_PAGINA}, por defecto ${por}).`);

const acceso = (a: AccesoMcp) => ({ role: a.role, permissions: a.permissions });
const scope = (a: AccesoMcp) => ({ userId: a.userId, storeId: a.storeId });

const corto = (texto: unknown, max: number) => {
    const t = typeof texto === 'string' ? texto : '';
    return t.length > max ? `${t.slice(0, max)}…` : t;
};

/** De un producto, solo lo que sirve para responder preguntas: sin atributos de IA ni datos internos. */
export function resumenDeProducto(p: any) {
    return {
        id: p.id,
        name: p.name,
        sku: p.sku,
        price: p.price != null ? Number(p.price) : null,
        salePrice: p.salePrice != null ? Number(p.salePrice) : null,
        stock: p.stock,
        category: p.category ?? null,
        subCategory: p.subCategory ?? null,
        status: p.status,
        image: (p.images ?? [])[0]?.url ?? null,
        group: p.groupSummary ?? null,
    };
}

export const HERRAMIENTAS: HerramientaMcp[] = [
    {
        name: 'listar_productos',
        title: 'Listar productos',
        description: 'Productos de la tienda con su precio, stock y categoría. Admite búsqueda por nombre, SKU o descripción.',
        permiso: 'productos.ver',
        input: {
            search: z.string().max(100).optional().describe('Texto libre: nombre, SKU o descripción.'),
            category: z.string().max(100).optional(),
            inStock: z.boolean().optional().describe('true para ver solo productos con stock.'),
            page: z.number().int().min(1).max(10_000).optional(),
            limit: tope(20),
        },
        async ejecutar({ products }, a, args) {
            const r = await products.findAll(scope(a), { page: args.page ?? 1, limit: Math.min(args.limit ?? 20, MAX_POR_PAGINA), search: args.search, category: args.category, inStock: args.inStock } as any);
            return { productos: r.data.map(resumenDeProducto), paginacion: r.meta };
        },
    },
    {
        name: 'ver_producto',
        title: 'Ver un producto',
        description: 'Ficha de un producto: datos, fotos, dónde está publicado y qué le falta para publicarse en cada canal.',
        permiso: 'productos.ver',
        input: { id: z.string().uuid().describe('El id del producto (lo da listar_productos).') },
        async ejecutar({ products, overview }, a, args) {
            const p: any = await products.findOne(args.id, a.userId, a.storeId);
            const estado = (await overview.obtener(scope(a), [args.id]))[args.id] ?? null;
            return {
                ...resumenDeProducto(p),
                description: corto(p.description, 1500),
                images: (p.images ?? []).slice(0, 8).map((i: any) => i.url),
                webPrice: p.webPrice != null ? Number(p.webPrice) : null,
                variantValues: p.variantValues ?? null,
                package: { width: p.packageWidth, length: p.packageLength, height: p.packageHeight, weight: p.packageWeight },
                createdAt: p.createdAt,
                updatedAt: p.updatedAt,
                canales: estado,
            };
        },
    },
    {
        name: 'listar_ventas',
        title: 'Listar ventas',
        description: 'Ventas de la tienda con sus productos, estado y envío. Los datos de contacto de los clientes solo salen si la clave tiene ese permiso.',
        permiso: 'ventas.ver',
        input: {
            from: fecha.describe('Desde (AAAA-MM-DD).'),
            to: fecha.describe('Hasta (AAAA-MM-DD).'),
            marketplace: z.string().max(40).optional(),
            search: z.string().max(100).optional().describe('Cliente, número de pedido, SKU o nombre.'),
            status: estadoDeVenta,
            limit: tope(20),
            offset: z.number().int().min(0).max(100_000).optional(),
        },
        async ejecutar({ orders }, a, args) {
            return orders.list(a.storeId, acceso(a), { ...args, limit: Math.min(args.limit ?? 20, MAX_POR_PAGINA) });
        },
    },
    {
        name: 'ver_venta',
        title: 'Ver una venta',
        description: 'Detalle de una venta: productos, precio pagado, envío y estado.',
        permiso: 'ventas.ver',
        input: { id: z.string().uuid().describe('El id de la venta (lo da listar_ventas).') },
        async ejecutar({ orders }, a, args) {
            return orders.detail(a.storeId, acceso(a), args.id);
        },
    },
    {
        name: 'resumen_negocio',
        title: 'Resumen del negocio',
        description: 'Canales conectados, catálogo, ventas del mes contra el anterior y stock en riesgo.',
        permiso: 'analiticas.ver',
        input: {},
        async ejecutar({ dashboard }, a) {
            // `avisos` son las notificaciones personales de quien creó la clave: no son de la tienda.
            const { avisos: _avisos, ...resumen } = (await dashboard.getSummary(scope(a))) as any;
            return resumen;
        },
    },
    {
        name: 'reporte_ventas',
        title: 'Reporte de ventas',
        description: 'Ventas por día, canal y cuenta en un rango de fechas (por defecto, los últimos 30 días).',
        permiso: 'analiticas.ver',
        input: {
            from: fecha.describe('Desde (AAAA-MM-DD).'),
            to: fecha.describe('Hasta (AAAA-MM-DD).'),
            status: estadoDeVenta,
            canal: z.string().max(60).optional().describe('Solo las ventas de este canal.'),
            incluirEnvio: z.boolean().optional().describe('false para no sumar lo que el cliente pagó por el envío.'),
        },
        async ejecutar({ reports }, a, args) {
            return reports.getSalesReport(a.storeId, args.from, args.to, args.status, args.incluirEnvio !== false, a.permissions.includes('costos.ver'), args.canal);
        },
    },
    {
        name: 'productos_ganadores',
        title: 'Productos ganadores',
        description: 'Lo más vendido del periodo, con su stock y en cuánto tiempo se agotaría.',
        permiso: 'analiticas.ver',
        input: {
            from: fecha.describe('Desde (AAAA-MM-DD).'),
            to: fecha.describe('Hasta (AAAA-MM-DD).'),
            status: estadoDeVenta,
            sort: z.enum(['units', 'revenue', 'days']).optional().describe('units (por defecto), revenue o days (se agota antes).'),
            canal: z.string().max(60).optional(),
            limit: tope(20),
        },
        async ejecutar({ reports }, a, args) {
            return reports.getTopProducts(a.storeId, args.from, args.to, args.status, args.sort ?? 'units', Math.min(args.limit ?? 20, MAX_POR_PAGINA), args.canal);
        },
    },
    {
        name: 'listar_cambios_pendientes',
        title: 'Cambios de precio y stock',
        description: 'Cambios de precio, stock o promoción que esperan aprobación (o ya resueltos) antes de llegar a los canales. Solo lectura: no aprueba nada.',
        permiso: 'canales.ver',
        input: { status: z.enum(['pending', 'approved', 'rejected', 'sent', 'error', 'skipped']).optional().describe('Por defecto, todos.') },
        async ejecutar({ changes }, a, args) {
            const filas: any[] = await changes.list(scope(a), args.status);
            return filas.slice(0, 200).map((c) => ({
                id: c.id,
                estado: c.status,
                campo: c.field,
                canal: c.marketplace,
                producto: c.product ? { id: c.product.id, name: c.product.name, sku: c.product.sku } : null,
                valorAnterior: c.previousValue,
                valorNuevo: c.newValue,
                mensaje: c.resultMessage,
                creado: c.createdAt,
                resuelto: c.resolvedAt,
            }));
        },
    },
];

/** La respuesta de una herramienta como texto, con tope de tamaño. */
export function aTexto(valor: unknown): string {
    const json = JSON.stringify(valor ?? null, null, 1);
    return json.length > MAX_CARACTERES
        ? `${json.slice(0, MAX_CARACTERES)}\n… [respuesta recortada: pide menos resultados o filtra más]`
        : json;
}
