/**
 * Registro de actividad de los usuarios (solo lo ve el superadmin). Ver docs/actividad-de-usuarios.md.
 */

/** Versión del aviso de privacidad. Si el texto cambia, se sube la versión y todos vuelven a aceptarlo. */
export const PRIVACY_VERSION = '2026-11-03';

/** Cuánto se conserva el detalle de cada clic, vista y acción. */
export const DIAS_DE_DETALLE = 90;
/** Cuánto se conservan los resúmenes por día y por hora (y las sesiones). */
export const DIAS_DE_RESUMEN = 730;

export const ZONA_HORARIA = 'America/Lima';

/** Eventos que acepta el navegador en cada envío. */
export const MAX_EVENTOS_POR_LOTE = 100;

export const TIPOS_DEL_NAVEGADOR = ['view', 'click', 'ping'] as const;
export type TipoDelNavegador = (typeof TIPOS_DEL_NAVEGADOR)[number];

export const ROLES_DE_PLATAFORMA = ['admin', 'contador', 'moderator', 'user'] as const;
export const ROLES_DE_TIENDA = ['owner', 'editor', 'viewer'] as const;

export const DISPOSITIVOS = ['escritorio', 'tablet', 'movil'] as const;

/** Cómo aceptó el aviso la persona. */
export const VIAS_DE_ACEPTACION = ['registro', 'invitacion', 'aviso'] as const;
export type ViaDeAceptacion = (typeof VIAS_DE_ACEPTACION)[number];

/**
 * Plano de cada pantalla: la forma de sus bloques (sin ningún texto), para dibujar los mapas de clics sobre la estructura
 * real. Solo estos tipos; lo demás se descarta.
 */
export const TIPOS_DE_BLOQUE = ['titulo', 'tabla', 'pestanas', 'grafico', 'imagen', 'campo', 'boton', 'tarjeta'] as const;
export type TipoDeBloque = (typeof TIPOS_DE_BLOQUE)[number];
export const MAX_BLOQUES_POR_PLANO = 150;
/** Un plano solo se renueva si el guardado tiene más de estas horas: evita que dos roles se lo pisen a cada rato. */
export const HORAS_ENTRE_PLANOS = 24;
