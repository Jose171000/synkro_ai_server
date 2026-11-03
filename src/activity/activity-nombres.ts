/**
 * Nombres legibles de lo que el rastreador registra con etiquetas técnicas, para los informes descargables (Excel y PDF).
 * Igual que `src/lib/activity-labels.ts` del frontend, que es lo que se ve en pantalla.
 */

const SECCIONES: Record<string, string> = {
    dashboard: 'Dashboard',
    products: 'Productos',
    'ai-products': 'IA Productos',
    marketplaces: 'Marketplaces',
    analytics: 'Analíticas',
    crm: 'CRM',
    admin: 'Superadmin',
    settings: 'Configuración',
};

export const NOMBRE_ROL_PLATAFORMA: Record<string, string> = {
    admin: 'Superadmin',
    contador: 'Contador',
    moderator: 'Moderador',
    user: 'Usuario',
};

export const NOMBRE_ROL_TIENDA: Record<string, string> = {
    owner: 'Dueño',
    editor: 'Editor',
    viewer: 'Visor',
};

const DIAS = ['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
export const nombreDeDia = (iso: number) => DIAS[iso] ?? '';

const humanizar = (t: string) => {
    const limpio = String(t ?? '').replace(/[-_]+/g, ' ').trim();
    return limpio ? limpio.charAt(0).toUpperCase() + limpio.slice(1) : String(t ?? '');
};

/** «marketplaces.ventas» → «Marketplaces › Ventas». */
export function nombreDePantalla(pantalla: string): string {
    const [base, ...resto] = String(pantalla ?? '').split('.');
    return [SECCIONES[base] ?? humanizar(base), ...resto.map(humanizar)].join(' › ');
}

export const nombreDeElemento = humanizar;

/** 3725 → «1 h 02 min»; 90 → «1 min 30 s»; 40 → «40 s». */
export function duracion(segundos: number): string {
    const s = Math.max(0, Math.round(Number(segundos) || 0));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min${s % 60 ? ` ${String(s % 60).padStart(2, '0')} s` : ''}`;
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

export const franjaHoraria = (h: number) => `${String(h).padStart(2, '0')}:00 - ${String((h + 1) % 24).padStart(2, '0')}:00`;

/** Del amarillo (poco) al rojo (mucho): [r, g, b] de 0 a 255. */
export function colorDeCalor(intensidad: number): [number, number, number] {
    const i = Math.min(1, Math.max(0, intensidad));
    const h = (50 - 50 * i) / 360, s = 0.95, l = 0.52;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const canal = (t0: number) => {
        let t = t0;
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
        return Math.round(v * 255);
    };
    return [canal(h + 1 / 3), canal(h), canal(h - 1 / 3)];
}
