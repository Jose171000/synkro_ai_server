/**
 * Nombres legibles de las acciones que se hacen en el servidor, y a qué pantalla pertenecen. Lo que no está en la lista se
 * anota con su método y ruta (sin identificadores), para no perder nada y poder darle nombre después.
 */

const ACCIONES: [RegExp, string, string][] = [
    [/^POST \/sync\/orders\/manual$/, 'Registrar venta manual', 'ventas'],
    [/^POST \/sync\/orders\/manual\/import$/, 'Importar ventas desde Excel', 'ventas'],
    [/^PUT \/sync\/orders\/manual\/:id$/, 'Editar venta manual', 'ventas'],
    [/^DELETE \/sync\/orders\/manual\/:id$/, 'Eliminar venta manual', 'ventas'],
    [/^POST \/sync\/orders\/sync$/, 'Actualizar ventas', 'ventas'],
    [/^POST \/sync\/orders\/import-history$/, 'Importar historial de ventas', 'ventas'],
    [/^POST \/bulk-upload\/products$/, 'Carga masiva de productos', 'ia-productos'],
    [/^POST \/bulk-upload\/products\/retry\/:batchId$/, 'Reintentar carga masiva', 'ia-productos'],
    [/^POST \/bulk-upload\/products\/edit$/, 'Edición masiva de productos', 'productos'],
    [/^POST \/products$/, 'Crear producto', 'productos'],
    [/^POST \/products\/with-ai(\/with-files)?$/, 'Crear producto con IA', 'ia-productos'],
    [/^POST \/products\/with-files$/, 'Crear producto con fotos', 'productos'],
    [/^POST \/products\/:id\/generate-ai$/, 'Generar datos con IA', 'ia-productos'],
    [/^PATCH \/products\/:id$/, 'Editar producto', 'productos'],
    [/^DELETE \/products\/:id$/, 'Eliminar producto', 'productos'],
    [/^POST \/auth\/logout$/, 'Cerrar sesión', 'cuenta'],
    [/^PATCH \/auth\/change-password$/, 'Cambiar contraseña', 'cuenta'],
];

const PANTALLAS_POR_PREFIJO: [string, string][] = [
    ['/sync/orders', 'ventas'],
    ['/sync', 'marketplaces'],
    ['/bulk-upload', 'ia-productos'],
    ['/ai', 'ia-productos'],
    ['/products', 'productos'],
    ['/reports', 'analiticas'],
    ['/dashboard', 'dashboard'],
    ['/crm', 'crm'],
    ['/admin', 'superadmin'],
    ['/stores', 'tiendas'],
    ['/auth', 'cuenta'],
];

/** Quita el prefijo del servidor («/api/v1») de una ruta. */
export function rutaLimpia(ruta: string): string {
    return String(ruta ?? '').replace(/^\/api(\/v\d+)?/, '') || '/';
}

export function pantallaDeRuta(ruta: string): string {
    const r = rutaLimpia(ruta);
    return PANTALLAS_POR_PREFIJO.find(([prefijo]) => r === prefijo || r.startsWith(`${prefijo}/`))?.[1] ?? 'otros';
}

/** Nombre legible y pantalla de una acción. `ruta` es el patrón de la ruta (con «:id»), no la dirección real. */
export function nombreDeAccion(metodo: string, ruta: string): { accion: string; pantalla: string } {
    const r = rutaLimpia(ruta);
    const clave = `${metodo.toUpperCase()} ${r}`;
    const conocida = ACCIONES.find(([patron]) => patron.test(clave));
    if (conocida) return { accion: conocida[1], pantalla: conocida[2] };
    return { accion: clave.slice(0, 120), pantalla: pantallaDeRuta(r) };
}

/** Rutas que no se anotan: el propio registro de actividad y el mantenimiento de la sesión. */
export function rutaExcluida(ruta: string): boolean {
    const r = rutaLimpia(ruta);
    return r.startsWith('/activity') || r === '/auth/refresh' || r === '/auth/login' || r === '/auth/register' || r.startsWith('/webhooks');
}

/** Solo lo que cambia datos cuenta como acción; leer no. */
export function esAccion(metodo: string): boolean {
    return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(metodo.toUpperCase());
}
