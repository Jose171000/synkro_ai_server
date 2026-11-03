import { ForbiddenException } from '@nestjs/common';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/user-role';
import { Reflector } from '@nestjs/core';
import { ActivityAdminController } from './activity-admin.controller';
import { ActivityController } from './activity.controller';
import { ActivityInterceptor } from './activity.interceptor';
import { esAccion, nombreDeAccion, pantallaDeRuta, rutaExcluida } from './activity-acciones';
import { leerFiltro, condicionesSql } from './activity-filter';
import { of } from 'rxjs';

describe('solo el superadmin ve y descarga la actividad', () => {
    const contexto = (rol: string) => ({
        getHandler: () => ActivityAdminController.prototype.resumen,
        getClass: () => ActivityAdminController,
        switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u', role: rol } }) }),
    }) as any;

    it('todas las consultas de actividad exigen el rol admin', () => {
        expect(Reflect.getMetadata(ROLES_KEY, ActivityAdminController)).toEqual([UserRole.ADMIN]);
    });

    it('el contador, el moderador y el usuario normal son rechazados; el admin pasa', () => {
        const guardia = new RolesGuard(new Reflector());
        for (const rol of ['contador', 'moderator', 'user']) expect(() => guardia.canActivate(contexto(rol))).toThrow(ForbiddenException);
        expect(guardia.canActivate(contexto('admin'))).toBe(true);
    });

    it('lo que usa cualquier usuario (enviar eventos, aceptar el aviso) no devuelve la actividad de nadie y no pide rol', () => {
        expect(Reflect.getMetadata(ROLES_KEY, ActivityController)).toBeUndefined();
        const metodos = Object.getOwnPropertyNames(ActivityController.prototype).filter((m) => m !== 'constructor');
        expect(metodos.sort()).toEqual(['aceptar', 'consentimiento', 'eventos']);
    });
});

describe('nombres de las acciones del servidor', () => {
    it('las conocidas tienen nombre legible y pantalla; las demás se anotan con método y ruta, sin identificadores', () => {
        expect(nombreDeAccion('POST', '/api/v1/sync/orders/manual')).toEqual({ accion: 'Registrar venta manual', pantalla: 'ventas' });
        expect(nombreDeAccion('DELETE', '/api/v1/sync/orders/manual/:id')).toEqual({ accion: 'Eliminar venta manual', pantalla: 'ventas' });
        expect(nombreDeAccion('POST', '/api/v1/sync/algo-nuevo/:id/hacer')).toEqual({ accion: 'POST /sync/algo-nuevo/:id/hacer', pantalla: 'marketplaces' });
    });

    it('la pantalla sale del inicio de la ruta', () => {
        expect(pantallaDeRuta('/api/v1/products/:id')).toBe('productos');
        expect(pantallaDeRuta('/api/v1/bulk-upload/products')).toBe('ia-productos');
        expect(pantallaDeRuta('/api/v1/algo')).toBe('otros');
    });

    it('leer no es una acción, y la propia actividad y el mantenimiento de sesión no se anotan', () => {
        expect(esAccion('GET')).toBe(false);
        expect(esAccion('post')).toBe(true);
        for (const ruta of ['/api/v1/activity/events', '/api/v1/auth/refresh', '/api/v1/auth/login', '/api/v1/webhooks/falabella']) expect(rutaExcluida(ruta)).toBe(true);
        expect(rutaExcluida('/api/v1/products')).toBe(false);
    });
});

describe('interceptor de acciones', () => {
    const contexto = (req: any) => ({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => req }) }) as any;
    const siguiente = { handle: () => of('ok') } as any;
    const ejecutar = async (req: any) => {
        const anotar = jest.fn(async () => undefined);
        const interceptor = new ActivityInterceptor({ anotar } as any);
        await new Promise<void>((fin) => interceptor.intercept(contexto(req), siguiente).subscribe({ complete: () => fin() }));
        return anotar;
    };

    it('anota una acción que cambia datos de alguien autenticado, con su tienda y roles', async () => {
        const anotar = await ejecutar({ method: 'POST', route: { path: '/api/v1/sync/orders/manual' }, user: { id: 'u1', role: 'user' }, store: { storeId: 's1', role: 'owner' } });
        expect(anotar).toHaveBeenCalledWith({ userId: 'u1', platformRole: 'user', storeId: 's1', storeRole: 'owner' }, 'action', 'Registrar venta manual', 'ventas');
    });

    it('no anota lecturas, rutas excluidas ni peticiones sin usuario', async () => {
        expect(await ejecutar({ method: 'GET', route: { path: '/api/v1/products' }, user: { id: 'u1' } })).not.toHaveBeenCalled();
        expect(await ejecutar({ method: 'POST', route: { path: '/api/v1/activity/events' }, user: { id: 'u1' } })).not.toHaveBeenCalled();
        expect(await ejecutar({ method: 'POST', route: { path: '/api/v1/products' } })).not.toHaveBeenCalled();
    });
});

describe('filtros de actividad', () => {
    const HOY = '2026-11-03';

    it('por defecto: últimos 30 días hasta hoy, todos los usuarios y promedio por usuario', () => {
        expect(leerFiltro({}, HOY)).toEqual({ desde: '2026-10-05', hasta: HOY, userId: null, rolesPlataforma: [], rolesTienda: [], promedio: true });
    });

    it('acepta varios roles de plataforma y de tienda a la vez, y una sola persona deja de promediar', () => {
        const f = leerFiltro({ platformRoles: 'user,contador', storeRoles: 'editor,viewer', mode: 'total' }, HOY);
        expect(f).toMatchObject({ rolesPlataforma: ['user', 'contador'], rolesTienda: ['editor', 'viewer'], promedio: false });
        const una = leerFiltro({ userId: '7d6f1c9e-3b1a-4f0e-9d2a-5c8e0a1b2c3d' }, HOY);
        expect(una.promedio).toBe(false);
    });

    it('rechaza roles, fechas, rangos y usuarios que no valen', () => {
        expect(() => leerFiltro({ platformRoles: 'superman' }, HOY)).toThrow(/Rol de plataforma no válido/);
        expect(() => leerFiltro({ storeRoles: 'jefe' }, HOY)).toThrow(/Rol de tienda no válido/);
        expect(() => leerFiltro({ from: '03/11/2026' }, HOY)).toThrow(/AAAA-MM-DD/);
        expect(() => leerFiltro({ from: '2026-11-04', to: HOY }, HOY)).toThrow(/posterior/);
        expect(() => leerFiltro({ from: '2020-01-01', to: HOY }, HOY)).toThrow(/730/);
        expect(() => leerFiltro({ userId: 'abc' }, HOY)).toThrow(/usuario no es válido/);
    });

    it('las condiciones SQL usan parámetros (nunca el texto del usuario dentro del SQL)', () => {
        const p: unknown[] = [];
        const sql = condicionesSql(leerFiltro({ platformRoles: 'user', storeRoles: 'owner,editor', userId: '7d6f1c9e-3b1a-4f0e-9d2a-5c8e0a1b2c3d' }, HOY), 'd', p);
        expect(sql).toContain('d."platformRole" = ANY(');
        expect(sql).toContain('d."storeRole" = ANY(');
        expect(sql).not.toMatch(/'(user|owner|editor)'/);
        expect(p).toEqual(['2026-10-05', HOY, '7d6f1c9e-3b1a-4f0e-9d2a-5c8e0a1b2c3d', ['user'], ['owner', 'editor']]);
    });
});
