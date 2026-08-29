/**
 * Secciones de la aplicación sobre las que se controla el acceso.
 * El superadmin decide cuáles ve cada usuario; la lista vacía o nula
 * significa acceso completo.
 *
 * ESTA ES LA ÚNICA LISTA. Al añadir un módulo nuevo basta con añadirlo aquí:
 * aparece solo en la pantalla de permisos del superadmin, porque el frontend
 * la pide al servidor en vez de mantener su propia copia.
 *
 * Antes había dos listas —esta y otra escrita a mano en el frontend— y
 * bastaba olvidar una para que un módulo quedara sin forma de restringirlo.
 */
export const SECTION_DEFINITIONS = [
    { id: 'dashboard', label: 'Dashboard', always: true },
    { id: 'products', label: 'Productos', always: false },
    { id: 'ai-products', label: 'IA para Productos', always: false },
    { id: 'marketplaces', label: 'Marketplaces', always: false },
    { id: 'crm', label: 'CRM', always: false },
    { id: 'analytics', label: 'Analíticas', always: false },
    { id: 'settings', label: 'Configuración', always: true },
] as const;

export type AppSection = typeof SECTION_DEFINITIONS[number]['id'];

export const APP_SECTIONS: readonly AppSection[] = SECTION_DEFINITIONS.map(s => s.id);

/** Secciones que siempre están disponibles, no se pueden restringir. */
export const ALWAYS_ALLOWED: AppSection[] = SECTION_DEFINITIONS
    .filter(s => s.always)
    .map(s => s.id);

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
