import type { StoreRole } from './entities/store-member.entity';

/**
 * Permisos de una tienda. Cada acceso es un permiso suelto; un rol es un conjunto de permisos. Los tres roles de fábrica
 * (Lector, Editor, Dueño) tienen los permisos de `PERMISOS_DE_FABRICA`; más adelante cada tienda podrá crear roles
 * personalizados con otros conjuntos. Ver docs/roles-de-tienda.md.
 *
 * Fuera del catálogo, y sin poder delegarse, queda la gestión del equipo (invitar, cambiar roles, enlace público, nombre de la
 * tienda, ver el plan y los cobros): es siempre del dueño y se comprueba por rol.
 */
export const PERMISOS = [
    // Ver
    'productos.ver',
    'canales.ver',
    'ventas.ver',
    'ventas.contacto',
    'analiticas.ver',
    'costos.ver',
    // Productos
    'productos.editar',
    'productos.eliminar',
    'productos.descargar',
    'inventario.editar',
    // Canales
    'canales.publicar',
    'canales.conectar',
    'cambios.aprobar',
    // Ventas
    'ventas.registrar',
    'ventas.descargar',
] as const;

export type Permiso = (typeof PERMISOS)[number];

export const esPermiso = (v: unknown): v is Permiso => typeof v === 'string' && (PERMISOS as readonly string[]).includes(v);

/** Permisos que otro permiso necesita para tener sentido: marcar uno marca también estos. */
export const DEPENDENCIAS: Partial<Record<Permiso, readonly Permiso[]>> = {
    'ventas.contacto': ['ventas.ver'],
    'productos.editar': ['productos.ver'],
    'productos.eliminar': ['productos.ver'],
    'productos.descargar': ['productos.ver'],
    'inventario.editar': ['productos.ver', 'canales.ver'],
    'canales.publicar': ['productos.ver', 'canales.ver'],
    'canales.conectar': ['canales.ver'],
    'cambios.aprobar': ['canales.ver'],
    'ventas.registrar': ['ventas.ver'],
    'ventas.descargar': ['ventas.ver'],
};

/** Qué es cada permiso, para las pantallas y los informes. `delicado` pide una advertencia al darlo. */
export const DESCRIPCION_DE_PERMISOS: Record<Permiso, { titulo: string; ayuda: string; grupo: string; delicado?: boolean }> = {
    'productos.ver': { grupo: 'Ver', titulo: 'Ver productos', ayuda: 'Lista, ficha y estado de cada producto' },
    'canales.ver': { grupo: 'Ver', titulo: 'Ver canales', ayuda: 'Cuentas conectadas, publicaciones y cambios pendientes' },
    'ventas.ver': { grupo: 'Ver', titulo: 'Ver ventas', ayuda: 'Lista de ventas y su detalle' },
    'ventas.contacto': { grupo: 'Ver', titulo: 'Ver datos de contacto de los clientes', ayuda: 'Teléfono, correo y dirección en el detalle de cada venta' },
    'analiticas.ver': { grupo: 'Ver', titulo: 'Ver analíticas', ayuda: 'Dashboard, gráficos, mapa de calor y rankings' },
    'costos.ver': { grupo: 'Ver', titulo: 'Ver costos y comisiones', ayuda: 'Envío, cupones y comisión en analíticas y ventas' },
    'productos.editar': { grupo: 'Productos', titulo: 'Crear y editar productos', ayuda: 'Con IA, carga masiva y variantes, de cualquier producto de la tienda' },
    'productos.eliminar': { grupo: 'Productos', titulo: 'Eliminar productos', ayuda: 'Borra productos de la tienda', delicado: true },
    'productos.descargar': { grupo: 'Productos', titulo: 'Descargar productos', ayuda: 'Excel de productos y de contenido IA' },
    'inventario.editar': { grupo: 'Productos', titulo: 'Cambiar inventario', ayuda: 'Stock, precio, promoción y precio web (con modo revisión queda pendiente)' },
    'canales.publicar': { grupo: 'Canales', titulo: 'Publicar y pausar', ayuda: 'Publicar, pausar y reactivar en los canales de la tienda', delicado: true },
    'canales.conectar': { grupo: 'Canales', titulo: 'Conectar canales', ayuda: 'Conectar y desconectar cuentas, importar publicaciones', delicado: true },
    'cambios.aprobar': { grupo: 'Canales', titulo: 'Aprobar cambios', ayuda: 'Aprobar o rechazar cambios y activar el modo revisión', delicado: true },
    'ventas.registrar': { grupo: 'Ventas', titulo: 'Registrar ventas', ayuda: 'Ventas manuales (crear, editar, eliminar, importar) y «Actualizar ventas ahora»' },
    'ventas.descargar': { grupo: 'Ventas', titulo: 'Descargar ventas', ayuda: 'Excel de ventas' },
};

/** Marca también lo que cada permiso necesita. */
export function cerrarDependencias(permisos: Iterable<Permiso>): Permiso[] {
    const resultado = new Set<Permiso>();
    const agregar = (p: Permiso) => {
        if (resultado.has(p)) return;
        resultado.add(p);
        (DEPENDENCIAS[p] ?? []).forEach(agregar);
    };
    for (const p of permisos) agregar(p);
    return PERMISOS.filter((p) => resultado.has(p));
}

const LECTOR: readonly Permiso[] = ['productos.ver', 'canales.ver', 'ventas.ver', 'analiticas.ver', 'costos.ver'];
const EDITOR: readonly Permiso[] = [
    ...LECTOR, 'ventas.contacto',
    'productos.editar', 'productos.eliminar', 'productos.descargar', 'inventario.editar',
    'canales.publicar', 'ventas.registrar', 'ventas.descargar',
];

/** Los permisos de los tres roles de fábrica. El dueño lo tiene todo. */
export const PERMISOS_DE_FABRICA: Record<StoreRole, readonly Permiso[]> = {
    viewer: LECTOR,
    editor: EDITOR,
    owner: PERMISOS,
};

export const permisosDeRol = (rol: StoreRole): Permiso[] => [...PERMISOS_DE_FABRICA[rol]];

export const NOMBRE_DE_ROL_DE_FABRICA: Record<StoreRole, string> = { viewer: 'Lector', editor: 'Editor', owner: 'Dueño' };

/**
 * ¿Estos permisos son exactamente los de un rol de fábrica? Es lo que decide si un conjunto marcado se muestra con el nombre
 * del rol de fábrica o como «Personalizado».
 */
export function rolDeFabricaIgualA(permisos: Iterable<Permiso>): StoreRole | null {
    const conjunto = new Set(permisos);
    for (const rol of ['viewer', 'editor', 'owner'] as StoreRole[]) {
        const base = PERMISOS_DE_FABRICA[rol];
        if (base.length === conjunto.size && base.every((p) => conjunto.has(p))) return rol;
    }
    return null;
}

// ── Roles personalizados ─────────────────────────────────────────────────

/** Nombres que un rol personalizado no puede usar: se confundirían con los de fábrica. */
export const NOMBRES_RESERVADOS = ['dueño', 'dueno', 'propietario', 'owner', 'editor', 'lector', 'viewer', 'personalizado'];

/**
 * Lo que llega del cliente (una lista de claves de permisos) convertido en un conjunto válido: sin repetidos, sin claves que no
 * existan y con lo que cada permiso necesita ya marcado. Devuelve además lo que se tuvo que agregar y lo que se descartó.
 */
export function normalizarPermisos(crudos: unknown): { permisos: Permiso[]; invalidos: string[]; agregados: Permiso[] } {
    const lista = Array.isArray(crudos) ? crudos : [];
    const invalidos = [...new Set(lista.filter((p) => !esPermiso(p)).map((p) => String(p).slice(0, 60)))];
    const pedidos = [...new Set(lista.filter(esPermiso))];
    const permisos = cerrarDependencias(pedidos);
    return { permisos, invalidos, agregados: permisos.filter((p) => !pedidos.includes(p)) };
}

/**
 * Lo que una persona puede hacer en una tienda: los permisos de su rol de fábrica o, si tiene un rol personalizado, los de ese
 * rol (siempre pasados por `normalizarPermisos`, así que un permiso retirado del catálogo nunca da acceso).
 */
export function permisosEfectivos(rol: StoreRole, personalizado?: { permissions?: unknown } | null): Permiso[] {
    if (personalizado) return normalizarPermisos(personalizado.permissions).permisos;
    return permisosDeRol(rol);
}
