/**
 * Secciones de la aplicación sobre las que se controla el acceso.
 * El superadmin decide cuáles ve cada usuario; la lista vacía o nula
 * significa acceso completo.
 */
export const APP_SECTIONS = [
    'dashboard',
    'products',
    'ai-products',
    'marketplaces',
    'analytics',
    'settings',
] as const;

export type AppSection = typeof APP_SECTIONS[number];

/** Secciones que siempre están disponibles, no se pueden restringir. */
export const ALWAYS_ALLOWED: AppSection[] = ['dashboard', 'settings'];

/**
 * ¿El usuario puede entrar a esta sección?
 * Sin restricciones configuradas → acceso total.
 */
export function canAccessSection(
    allowedSections: string[] | null | undefined,
    section: AppSection,
): boolean {
    if (ALWAYS_ALLOWED.includes(section)) return true;
    if (!allowedSections || allowedSections.length === 0) return true;
    return allowedSections.includes(section);
}
