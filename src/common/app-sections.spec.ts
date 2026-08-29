import { ALWAYS_ALLOWED, APP_SECTIONS, canAccessSection, SECTION_DEFINITIONS } from './app-sections';

/**
 * Esta lista es la única fuente: el frontend la pide en vez de tener copia.
 * Las pruebas fijan esa regla para que un módulo nuevo no pueda quedarse
 * sin forma de restringirlo, que es justo lo que pasó con el CRM.
 */
describe('secciones de la aplicación', () => {
    it('cada sección declara id, nombre visible y si es restringible', () => {
        for (const s of SECTION_DEFINITIONS) {
            expect(s.id).toBeTruthy();
            expect(s.label).toBeTruthy();
            expect(typeof s.always).toBe('boolean');
        }
    });

    it('no hay ids repetidos', () => {
        const ids = SECTION_DEFINITIONS.map(s => s.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('todo módulo con pantalla propia se puede conceder o quitar', () => {
        // Si mañana se añade un módulo, debe aparecer aquí o no habrá manera
        // de restringirlo desde el superadmin.
        const restringibles = SECTION_DEFINITIONS.filter(s => !s.always).map(s => s.id);
        expect(restringibles).toEqual(
            expect.arrayContaining(['products', 'ai-products', 'marketplaces', 'crm', 'analytics']),
        );
    });

    it('las listas derivadas concuerdan con las definiciones', () => {
        expect(APP_SECTIONS).toEqual(SECTION_DEFINITIONS.map(s => s.id));
        expect(ALWAYS_ALLOWED).toEqual(SECTION_DEFINITIONS.filter(s => s.always).map(s => s.id));
    });

    describe('quién entra a dónde', () => {
        it('sin restricciones configuradas, acceso completo', () => {
            expect(canAccessSection(null, 'crm')).toBe(true);
            expect(canAccessSection([], 'crm')).toBe(true);
        });

        it('con acceso limitado, solo lo marcado', () => {
            expect(canAccessSection(['products', 'analytics'], 'crm')).toBe(false);
            expect(canAccessSection(['products', 'crm'], 'crm')).toBe(true);
        });

        it('Dashboard y Configuración no se pueden quitar nunca', () => {
            expect(canAccessSection(['products'], 'dashboard')).toBe(true);
            expect(canAccessSection(['products'], 'settings')).toBe(true);
        });
    });
});
