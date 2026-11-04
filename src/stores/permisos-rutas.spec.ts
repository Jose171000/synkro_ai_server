import 'reflect-metadata';
import { SyncController } from '../sync/sync.controller';
import { ProductsController } from '../products/products.controller';
import { BulkUploadController } from '../bulk-upload/bulk-upload.controller';
import { FalabellaPrepController } from '../ai/falabella-prep.controller';
import { DashboardController } from '../dashboard/dashboard.controller';
import { ExportController } from '../export/export.controller';
import { ReportsController } from '../reports/reports.controller';
import { STORE_PERMISSION_KEY, STORE_ROLE_KEY, StoreAccessGuard } from './store-access.guard';
import { esPermiso } from './permissions';

const CONTROLADORES = [SyncController, ProductsController, BulkUploadController, FalabellaPrepController, DashboardController, ExportController, ReportsController];
const VERBOS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

/** Cada ruta de la aplicación que depende de una tienda, con el guard de tienda y su permiso, según Nest. */
function rutasDeTienda() {
    const filas: { clave: string; guard: boolean; permiso: string | undefined; rol: string | undefined }[] = [];
    for (const C of CONTROLADORES) {
        const base = Reflect.getMetadata('path', C);
        const guardClase = (Reflect.getMetadata('__guards__', C) ?? []).includes(StoreAccessGuard);
        for (const nombre of Object.getOwnPropertyNames(C.prototype)) {
            const h = (C.prototype as any)[nombre];
            if (nombre === 'constructor' || typeof h !== 'function') continue;
            const metodo = Reflect.getMetadata('method', h);
            if (metodo === undefined) continue;
            const ruta = Reflect.getMetadata('path', h);
            filas.push({
                clave: `${C.name.replace('Controller', '')} ${VERBOS[metodo]} /${[base, ruta === '/' ? '' : ruta].filter(Boolean).join('/')}`,
                guard: guardClase || (Reflect.getMetadata('__guards__', h) ?? []).includes(StoreAccessGuard),
                permiso: Reflect.getMetadata(STORE_PERMISSION_KEY, h) ?? Reflect.getMetadata(STORE_PERMISSION_KEY, C),
                rol: Reflect.getMetadata(STORE_ROLE_KEY, h) ?? Reflect.getMetadata(STORE_ROLE_KEY, C),
            });
        }
    }
    return filas;
}

/**
 * LA TABLA DE PERMISOS POR RUTA (docs/roles-de-tienda.md). Si cambias el permiso de una ruta, o agregas una ruta de tienda, esta
 * prueba falla a propósito: quien lo haga debe actualizar la tabla a la vista de todos.
 */
const TABLA: Record<string, string> = {
    'Sync GET /sync/connections': 'canales.ver',
    'Sync GET /sync/mercadolibre/auth-url': 'canales.conectar',
    'Sync POST /sync/yavendio/connect': 'canales.conectar',
    'Sync GET /sync/yavendio/import/products': 'canales.conectar',
    'Sync POST /sync/yavendio/import/products/link': 'canales.conectar',
    'Sync POST /sync/yavendio/import/orders': 'canales.conectar',
    'Sync POST /sync/falabella/connect': 'canales.conectar',
    'Sync POST /sync/woocommerce/connect': 'canales.conectar',
    'Sync POST /sync/shopify/connect': 'canales.conectar',
    'Sync POST /sync/ripley/connect': 'canales.conectar',
    'Sync POST /sync/channels/:marketplace/listings/import': 'canales.conectar',
    'Sync GET /sync/listings': 'canales.ver',
    'Sync DELETE /sync/connections/:connectionId': 'canales.conectar',
    'Sync POST /sync/products/:id/publish': 'canales.publicar',
    'Sync GET /sync/falabella/categories': 'canales.publicar',
    'Sync GET /sync/falabella/categories/:categoryId/fields': 'canales.publicar',
    'Sync GET /sync/falabella/categories/:categoryId/variants': 'canales.publicar',
    'Sync GET /sync/products/:id/sheet': 'productos.ver',
    'Sync PATCH /sync/products/:id/sheet': 'productos.editar',
    'Sync POST /sync/products/:id/sheet/sync': 'canales.publicar',
    'Sync GET /sync/falabella/brands': 'canales.publicar',
    'Sync POST /sync/mercadolibre/products/:id/link': 'canales.publicar',
    'Sync PATCH /sync/falabella/products/:id/brand': 'canales.publicar',
    'Sync PATCH /sync/falabella/products/:id/preparation': 'canales.publicar',
    'Sync POST /sync/falabella/publish': 'canales.publicar',
    'Sync PATCH /sync/products/:id/inventory': 'inventario.editar',
    'Sync POST /sync/falabella/variants/group': 'canales.publicar',
    'Sync POST /sync/products/mark-imported': 'canales.conectar',
    'Sync POST /sync/channels/verify': 'canales.conectar',
    'Sync POST /sync/mercadolibre/duplicates/:action': 'canales.conectar',
    'Sync POST /sync/products/:id/channels/:action': 'canales.publicar',
    'Sync PATCH /sync/products/:id/promo': 'inventario.editar',
    'Sync PATCH /sync/products/:id/web-price': 'inventario.editar',
    'Sync GET /sync/change-requests': 'canales.ver',
    'Sync POST /sync/change-requests/:id/approve': 'cambios.aprobar',
    'Sync POST /sync/change-requests/:id/reject': 'cambios.aprobar',
    'Sync GET /sync/settings': 'canales.ver',
    'Sync PATCH /sync/settings/review-mode': 'cambios.aprobar',
    'Sync GET /sync/products/:id/status': 'canales.ver',
    'Sync POST /sync/falabella/webhook/register': 'canales.conectar',
    'Sync POST /sync/falabella/listings/import': 'canales.conectar',
    'Sync POST /sync/falabella/orders/sync': 'ventas.registrar',
    'Sync GET /sync/orders': 'ventas.ver',
    'Sync GET /sync/orders/export': 'ventas.descargar',
    'Sync GET /sync/orders/manual/products': 'ventas.registrar',
    'Sync PUT /sync/orders/manual/:id': 'ventas.registrar',
    'Sync DELETE /sync/orders/manual/:id': 'ventas.registrar',
    'Sync GET /sync/orders/manual/template': 'ventas.registrar',
    'Sync POST /sync/orders/manual': 'ventas.registrar',
    'Sync POST /sync/orders/manual/import': 'ventas.registrar',
    'Sync GET /sync/orders/:id': 'ventas.ver',
    'Sync POST /sync/mercadolibre/listings/import': 'canales.conectar',
    'Sync POST /sync/listings/refresh': 'canales.conectar',
    'Sync POST /sync/orders/import-history': 'canales.conectar',
    'Sync POST /sync/orders/sync': 'ventas.registrar',
    'Products POST /products': 'productos.editar',
    'Products POST /products/with-files': 'productos.editar',
    'Products GET /products/sku/next': 'productos.editar',
    'Products POST /products/groups': 'productos.editar',
    'Products POST /products/variants/detect': 'productos.editar',
    'Products GET /products/groups/:id': 'productos.ver',
    'Products POST /products/:id/variants': 'productos.editar',
    'Products POST /products/with-ai': 'productos.editar',
    'Products POST /products/with-ai/with-files': 'productos.editar',
    'Products GET /products/overview': 'productos.ver',
    'Products GET /products/summary': 'productos.ver',
    'Products GET /products': 'productos.ver',
    'Products GET /products/:id': 'productos.ver',
    'Products POST /products/:id/generate-ai': 'productos.editar',
    'Products PATCH /products/:id': 'productos.editar',
    'Products DELETE /products/:id': 'productos.eliminar',
    'BulkUpload GET /bulk-upload/products/template': 'productos.editar',
    'BulkUpload POST /bulk-upload/products': 'productos.editar',
    'BulkUpload GET /bulk-upload/products/progress/:batchId': 'productos.editar',
    'BulkUpload POST /bulk-upload/products/retry/:batchId': 'productos.editar',
    'BulkUpload POST /bulk-upload/products/edit': 'productos.editar',
    'BulkUpload GET /bulk-upload/products/edit/status': 'productos.editar',
    'FalabellaPrep POST /ai/products/:id/prepare-falabella': 'canales.publicar',
    'FalabellaPrep POST /ai/products/:id/suggest-falabella-attributes': 'canales.publicar',
    'FalabellaPrep POST /ai/products/:id/launch': 'canales.publicar',
    'FalabellaPrep POST /ai/products/:id/update-falabella': 'canales.publicar',
    'Dashboard GET /dashboard/summary': 'analiticas.ver',
    'Dashboard GET /dashboard/insights': 'analiticas.ver',
    'Export GET /export/products/:format': 'productos.descargar',
    'Export GET /export/ai-content/:format': 'productos.descargar',
    'Reports GET /reports/config': 'analiticas.ver',
    'Reports GET /reports/sales': 'analiticas.ver',
};

describe('permisos de cada ruta de tienda', () => {
    const rutas = rutasDeTienda().filter((r) => r.guard);

    it('la tabla coincide exactamente con lo que exige el código (ni una ruta de más ni de menos)', () => {
        const real = Object.fromEntries(rutas.map((r) => [r.clave, r.permiso ?? `(rol ${r.rol})`]));
        expect(real).toEqual(TABLA);
    });

    it('ninguna ruta con guard de tienda queda sin permiso explícito (antes, sin rol, valía «cualquier miembro»)', () => {
        expect(rutas.filter((r) => !r.permiso).map((r) => r.clave)).toEqual([]);
    });

    it('todos los permisos usados existen en el catálogo', () => {
        for (const r of rutas) expect(esPermiso(r.permiso)).toBe(true);
    });

    it('lo que no tiene guard de tienda es a propósito: webhooks, callback de OAuth, categorías y agencia (superadmin)', () => {
        const sinGuard = rutasDeTienda().filter((r) => !r.guard).map((r) => r.clave).sort();
        expect(sinGuard).toEqual([
            'BulkUpload GET /bulk-upload/categories/edit/status',
            'BulkUpload GET /bulk-upload/categories/status',
            'BulkUpload POST /bulk-upload/categories',
            'BulkUpload POST /bulk-upload/categories/edit',
            'Dashboard GET /dashboard/accounts',
            'Dashboard GET /dashboard/agency',
            'Dashboard GET /dashboard/agency/stores/:id',
            'Dashboard PATCH /dashboard/agency/stores/:id/plan',
            'Dashboard POST /dashboard/agency/stores/:id/payments',
            'Sync GET /sync/mercadolibre/callback',
            'Sync POST /sync/webhooks/falabella/:token',
            'Sync POST /sync/webhooks/mercadolibre',
        ]);
    });
});
