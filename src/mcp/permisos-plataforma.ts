import type { Permiso } from '../stores/permissions';

/**
 * Permisos de una clave del MCP de PLATAFORMA (la de un superadmin, `/api/v1/mcp/admin`): lo que puede ver de toda la agencia.
 * Son SOLO de lectura y no tienen que ver con los permisos de una tienda (`stores/permissions.ts`).
 *
 * No hay `actividad.ver` a propósito: el aviso de privacidad promete que la actividad de los usuarios solo la ven los
 * administradores, y con el MCP esa información pasaría al modelo de IA de quien tenga la clave. Si algún día se decide
 * abrirla, se agrega aquí (apagada por defecto) y se actualiza el aviso.
 */
export const PERMISOS_PLATAFORMA = ['clientes.ver', 'finanzas.ver', 'sistema.ver'] as const;
export type PermisoPlataforma = (typeof PERMISOS_PLATAFORMA)[number];

export const esPermisoPlataforma = (v: unknown): v is PermisoPlataforma =>
    typeof v === 'string' && (PERMISOS_PLATAFORMA as readonly string[]).includes(v);

/** Lo que lleva una clave de plataforma si no se dice otra cosa: solo los clientes. Lo demás hay que pedirlo. */
export const PERMISOS_PLATAFORMA_POR_DEFECTO: readonly PermisoPlataforma[] = ['clientes.ver'];

/** Qué es cada permiso, para la pantalla. `sensible` pide un aviso: esos datos pasan al modelo de IA de quien tenga la clave. */
export const DESCRIPCION_PLATAFORMA: Record<PermisoPlataforma, { titulo: string; ayuda: string; sensible: boolean }> = {
    'clientes.ver': {
        titulo: 'Clientes y tiendas',
        ayuda: 'Lista de clientes, solicitudes de registro y, de cada tienda, sus productos, ventas, reportes y cambios pendientes (sin datos de contacto de sus compradores)',
        sensible: true,
    },
    'finanzas.ver': {
        titulo: 'Finanzas y cartera',
        ayuda: 'Pagos, planes, cuotas, comisiones, cobros vencidos y el costo de envío y cupones de las ventas de cada tienda',
        sensible: true,
    },
    'sistema.ver': {
        titulo: 'Estado del sistema',
        ayuda: 'Memoria y colas de Redis, y la lista de todas las claves del MCP',
        sensible: false,
    },
};

/**
 * Lo que una clave de plataforma puede ver DENTRO de cada tienda, según sus permisos. Nunca incluye `ventas.contacto`:
 * el teléfono, el correo y la dirección de los compradores de un cliente no salen por el MCP de plataforma.
 */
export const PERMISOS_DE_TIENDA_POR_PLATAFORMA: Record<PermisoPlataforma, readonly Permiso[]> = {
    'clientes.ver': ['productos.ver', 'canales.ver', 'ventas.ver', 'analiticas.ver'],
    'finanzas.ver': ['costos.ver'],
    'sistema.ver': [],
};

export function permisosDeTiendaParaPlataforma(permisos: readonly PermisoPlataforma[]): Permiso[] {
    return [...new Set(permisos.flatMap((p) => PERMISOS_DE_TIENDA_POR_PLATAFORMA[p]))];
}
