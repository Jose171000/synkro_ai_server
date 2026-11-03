import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
    cerrarDependencias, DEPENDENCIAS, DESCRIPCION_DE_PERMISOS, Permiso, PERMISOS, PERMISOS_DE_FABRICA, permisosDeRol, rolDeFabricaIgualA,
} from './permissions';
import { RequirePermission, StoreAccessGuard } from './store-access.guard';
import { StoresService } from './stores.service';
import { StoreRole } from './entities/store-member.entity';
import { UserRole } from '../users/user-role';

/** Lo acordado con el dueño del producto (docs/roles-de-tienda.md), escrito a mano: si alguien cambia un rol de fábrica, esto falla. */
const ACORDADO: Record<StoreRole, Partial<Record<Permiso, boolean>>> = {
    viewer: {
        'productos.ver': true, 'canales.ver': true, 'ventas.ver': true, 'analiticas.ver': true, 'costos.ver': true,
        'ventas.contacto': false, 'productos.editar': false, 'productos.eliminar': false, 'productos.descargar': false, 'inventario.editar': false,
        'canales.publicar': false, 'canales.conectar': false, 'cambios.aprobar': false, 'ventas.registrar': false, 'ventas.descargar': false,
    },
    editor: {
        'productos.ver': true, 'canales.ver': true, 'ventas.ver': true, 'analiticas.ver': true, 'costos.ver': true,
        'ventas.contacto': true, 'productos.editar': true, 'productos.eliminar': true, 'productos.descargar': true, 'inventario.editar': true,
        'canales.publicar': true, 'canales.conectar': false, 'cambios.aprobar': false, 'ventas.registrar': true, 'ventas.descargar': true,
    },
    owner: Object.fromEntries(PERMISOS.map((p) => [p, true])),
};

describe('catálogo de permisos', () => {
    it('los roles de fábrica tienen exactamente los permisos acordados', () => {
        for (const rol of ['viewer', 'editor', 'owner'] as StoreRole[]) {
            for (const p of PERMISOS) expect({ rol, p, tiene: permisosDeRol(rol).includes(p) }).toEqual({ rol, p, tiene: !!ACORDADO[rol][p] });
        }
    });

    it('el lector está dentro del editor y el editor dentro del dueño; el dueño lo tiene todo', () => {
        expect(PERMISOS_DE_FABRICA.viewer.every((p) => PERMISOS_DE_FABRICA.editor.includes(p))).toBe(true);
        expect(PERMISOS_DE_FABRICA.editor.every((p) => PERMISOS_DE_FABRICA.owner.includes(p))).toBe(true);
        expect([...PERMISOS_DE_FABRICA.owner].sort()).toEqual([...PERMISOS].sort());
    });

    it('cada rol de fábrica ya incluye lo que sus permisos necesitan (no depende de nada que le falte)', () => {
        for (const rol of ['viewer', 'editor', 'owner'] as StoreRole[]) {
            expect(cerrarDependencias(PERMISOS_DE_FABRICA[rol])).toEqual(PERMISOS.filter((p) => PERMISOS_DE_FABRICA[rol].includes(p)));
        }
    });

    it('marcar un permiso marca también lo que necesita, y las dependencias no se piden en círculo', () => {
        expect(cerrarDependencias(['inventario.editar'])).toEqual(['productos.ver', 'canales.ver', 'inventario.editar']);
        expect(cerrarDependencias(['ventas.descargar'])).toEqual(['ventas.ver', 'ventas.descargar']);
        expect(cerrarDependencias([])).toEqual([]);
        for (const [p, deps] of Object.entries(DEPENDENCIAS)) for (const d of deps!) expect(DEPENDENCIAS[d]?.includes(p as Permiso) ?? false).toBe(false);
    });

    it('todo permiso tiene descripción y los delicados están marcados', () => {
        for (const p of PERMISOS) expect(DESCRIPCION_DE_PERMISOS[p].titulo.length).toBeGreaterThan(3);
        const delicados = PERMISOS.filter((p) => DESCRIPCION_DE_PERMISOS[p].delicado);
        expect(delicados).toEqual(['productos.eliminar', 'canales.publicar', 'canales.conectar', 'cambios.aprobar']);
    });

    it('un conjunto igual al de un rol de fábrica es ese rol; si falta o sobra uno, es personalizado', () => {
        expect(rolDeFabricaIgualA(PERMISOS_DE_FABRICA.editor)).toBe('editor');
        expect(rolDeFabricaIgualA([...PERMISOS_DE_FABRICA.viewer].reverse())).toBe('viewer');
        expect(rolDeFabricaIgualA(PERMISOS)).toBe('owner');
        expect(rolDeFabricaIgualA(PERMISOS_DE_FABRICA.editor.filter((p) => p !== 'productos.eliminar'))).toBeNull();
        expect(rolDeFabricaIgualA([...PERMISOS_DE_FABRICA.viewer, 'productos.descargar'])).toBeNull();
    });
});

describe('el guard de tienda con cada rol', () => {
    const ID = '26de71cc-aba3-4c7b-bebb-0827d063b764';
    const TIENDA = '1a2b3c4d-1111-4222-8333-444455556666';

    function servicio(rolEnTienda: StoreRole | null, rolDePlataforma: string = UserRole.USER) {
        const users: any = { findOne: jest.fn(async () => ({ id: ID, role: rolDePlataforma })) };
        const members: any = { findOne: jest.fn(async () => (rolEnTienda ? { role: rolEnTienda } : null)) };
        const stores: any = { exist: jest.fn(async () => true) };
        return new (StoresService as any)(stores, members, {}, users, {}, {}) as StoresService;
    }

    class Ejemplo {
        @RequirePermission('productos.editar') editar() { return 1; }
        @RequirePermission('canales.conectar') conectar() { return 1; }
        @RequirePermission('ventas.descargar') descargar() { return 1; }
    }

    async function intentar(rol: StoreRole | null, metodo: keyof Ejemplo, plataforma: string = UserRole.USER) {
        const guard = new StoreAccessGuard(new Reflector(), servicio(rol, plataforma));
        const req: any = { user: { id: ID }, headers: { 'x-store-id': TIENDA }, params: {} };
        const contexto = { getHandler: () => Ejemplo.prototype[metodo], getClass: () => Ejemplo, switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
        const ok = await guard.canActivate(contexto);
        return { ok, store: req.store };
    }

    it('el lector no edita ni descarga; el editor edita y descarga pero no conecta canales; el dueño todo', async () => {
        await expect(intentar('viewer', 'editar')).rejects.toBeInstanceOf(ForbiddenException);
        await expect(intentar('viewer', 'descargar')).rejects.toBeInstanceOf(ForbiddenException);
        await expect(intentar('editor', 'conectar')).rejects.toBeInstanceOf(ForbiddenException);
        expect((await intentar('editor', 'editar')).ok).toBe(true);
        expect((await intentar('editor', 'descargar')).ok).toBe(true);
        for (const m of ['editar', 'conectar', 'descargar'] as const) expect((await intentar('owner', m)).ok).toBe(true);
    });

    it('quien no es miembro de la tienda no entra a nada, ni siquiera con un permiso que otros roles tienen', async () => {
        await expect(intentar(null, 'editar')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('el superadmin de la plataforma entra a cualquier tienda con todos los permisos', async () => {
        const { ok, store } = await intentar(null, 'conectar', UserRole.ADMIN);
        expect(ok).toBe(true);
        expect(store.role).toBe('owner');
        expect([...store.permissions].sort()).toEqual([...PERMISOS].sort());
    });

    it('el acceso comprobado deja en la petición el rol y los permisos', async () => {
        const { store } = await intentar('editor', 'editar');
        expect(store).toMatchObject({ storeId: TIENDA, role: 'editor' });
        expect(store.permissions).toEqual(permisosDeRol('editor'));
    });
});
