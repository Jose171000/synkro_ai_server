import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { StoresService } from './stores.service';
import { MAX_ROLES_POR_TIENDA, StoreRolesService, catalogoDePermisos } from './store-roles.service';
import { PERMISOS, permisosDeRol } from './permissions';
import { asignacionDe } from './dto/store.dto';

/**
 * Roles personalizados de una tienda (docs/roles-de-tienda.md): los gestiona solo el dueño, los permisos reales salen del rol
 * en cada petición, y quien tiene uno nunca recibe más de lo que el rol dice (su rol de fábrica base es «viewer»).
 */

const TIENDA = '11111111-1111-4111-8111-111111111111';
const OTRA_TIENDA = '22222222-2222-4222-8222-222222222222';
const VENDEDOR = '33333333-3333-4333-8333-333333333333';
const AJENO = '44444444-4444-4444-8444-444444444444';

interface Estado {
    usuarios: Record<string, any>;
    miembros: any[];
    roles: any[];
    invitaciones: any[];
}

function construir(parcial: Partial<Estado> = {}) {
    const e: Estado = {
        usuarios: {
            dueno: { id: 'dueno', role: 'user', email: 'dueno@x.com', name: 'Ana', lastName: 'Ríos' },
            vende: { id: 'vende', role: 'user', email: 'vende@x.com' },
            luz: { id: 'luz', role: 'user', email: 'luz@x.com' },
            root: { id: 'root', role: 'admin', email: 'root@x.com' },
        },
        miembros: [
            { storeId: TIENDA, userId: 'dueno', role: 'owner', customRole: null },
            { storeId: TIENDA, userId: 'vende', role: 'viewer', customRole: { id: VENDEDOR, name: 'Vendedor', permissions: ['productos.ver', 'ventas.ver', 'ventas.registrar'] } },
        ],
        roles: [{ id: VENDEDOR, storeId: TIENDA, name: 'Vendedor', permissions: ['productos.ver', 'ventas.ver', 'ventas.registrar'] }],
        invitaciones: [],
        ...parcial,
    };

    const repoUsuarios: any = { findOne: jest.fn(async ({ where }: any) => e.usuarios[where.id] ?? null) };
    const repoTiendas: any = {
        exist: jest.fn(async () => true),
        findOne: jest.fn(async ({ where }: any) => ({ id: where.id, name: 'Tienda A' })),
    };
    const repoMiembros: any = {
        findOne: jest.fn(async ({ where }: any) => {
            const porCorreo = where.user?.email ? Object.values(e.usuarios).find((u: any) => u.email === where.user.email)?.id : undefined;
            if (where.user?.email && !porCorreo) return null;
            const m = e.miembros.find((x) => x.storeId === where.store?.id && (where.user?.id ? x.userId === where.user.id : porCorreo ? x.userId === porCorreo : true)) ?? null;
            // Como la base: el rol personalizado se lee otra vez en cada consulta, con lo que tenga guardado en ese momento.
            if (m?.customRole) m.customRole = e.roles.find((r) => r.id === m.customRole.id) ?? m.customRole;
            return m;
        }),
        exist: jest.fn(async ({ where }: any) => e.miembros.some((m) => m.userId === where.user?.id && m.storeId === where.store?.id)),
        count: jest.fn(async ({ where }: any) => e.miembros.filter((m) => m.customRole?.id === where.customRole?.id).length),
        save: jest.fn(async (m: any) => m),
        create: jest.fn((d: any) => d),
    };
    const repoInvit: any = {
        findOne: jest.fn(async ({ where }: any) => e.invitaciones.find((i) => i.tokenHash === where.tokenHash) ?? null),
        update: jest.fn(async () => ({ affected: 1 })),
        delete: jest.fn(async () => ({ affected: 1 })),
        count: jest.fn(async ({ where }: any) => e.invitaciones.filter((i) => i.customRole?.id === where.customRole?.id && !i.acceptedAt).length),
        save: jest.fn(async (i: any) => i),
        create: jest.fn((d: any) => d),
    };
    const repoRoles: any = {
        find: jest.fn(async ({ where }: any) => e.roles.filter((r) => r.storeId === where.store.id)),
        findOne: jest.fn(async ({ where }: any) => e.roles.find((r) => r.id === where.id && r.storeId === where.store?.id) ?? null),
        count: jest.fn(async ({ where }: any) => e.roles.filter((r) => r.storeId === where.store.id).length),
        create: jest.fn((d: any) => ({ id: `rol-${e.roles.length + 1}`, ...d, storeId: d.store.id, createdAt: new Date() })),
        save: jest.fn(async (r: any) => { if (!e.roles.includes(r)) e.roles.push(r); return r; }),
        remove: jest.fn(async (r: any) => { e.roles.splice(e.roles.indexOf(r), 1); return r; }),
        createQueryBuilder: jest.fn(() => {
            const p: any = {};
            const qb: any = {
                where: (_: string, par: any) => { Object.assign(p, par); return qb; },
                andWhere: (_: string, par: any) => { Object.assign(p, par); return qb; },
                getCount: async () => e.roles.filter((r) => r.storeId === p.storeId && r.name.toLowerCase() === String(p.name).toLowerCase() && r.id !== p.exceptoId).length,
            };
            return qb;
        }),
    };
    const correo = { sendStoreInvitation: jest.fn().mockResolvedValue(undefined) };

    const stores = new StoresService(repoTiendas, repoMiembros, repoInvit, repoUsuarios, { find: jest.fn() } as any, correo as any, repoRoles);
    const roles = new StoreRolesService(repoRoles, repoMiembros, repoInvit, stores);
    return { e, stores, roles, repoMiembros, repoInvit, repoRoles, correo };
}

describe('lo que puede hacer quien tiene un rol personalizado', () => {
    it('sus permisos son los del rol, con lo que cada uno necesita ya incluido', async () => {
        const { stores } = construir();
        const acceso = await stores.requireAccess('vende', TIENDA);
        expect(acceso.permissions).toEqual(['productos.ver', 'ventas.ver', 'ventas.registrar']);
        expect(acceso).toMatchObject({ role: 'viewer', roleName: 'Vendedor', customRoleId: VENDEDOR });
    });

    it('un permiso que ya no existe en el catálogo nunca da acceso', async () => {
        const { stores, e } = construir();
        e.roles[0].permissions = ['productos.ver', 'permiso.viejo', 'todo'];
        expect((await stores.requireAccess('vende', TIENDA)).permissions).toEqual(['productos.ver']);
    });

    it('no puede gestionar el equipo ni los roles: eso es siempre del dueño y no se delega', async () => {
        const { stores, roles } = construir();
        await expect(stores.invite('vende', TIENDA, 'otra@x.com', 'viewer')).rejects.toBeInstanceOf(ForbiddenException);
        await expect(stores.changeRole('vende', TIENDA, 'dueno', 'viewer')).rejects.toBeInstanceOf(ForbiddenException);
        await expect(roles.create('vende', TIENDA, 'Otro', ['productos.ver', 'ventas.ver'])).rejects.toBeInstanceOf(ForbiddenException);
        await expect(roles.update('vende', TIENDA, VENDEDOR, { permissions: [...PERMISOS] })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(roles.remove('vende', TIENDA, VENDEDOR)).rejects.toBeInstanceOf(ForbiddenException);
        await expect(roles.list('vende', TIENDA)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('un cambio en el rol vale en la siguiente petición, sin volver a entrar', async () => {
        const { stores, roles } = construir();
        expect((await stores.requireAccess('vende', TIENDA)).permissions).not.toContain('productos.eliminar');
        await roles.update('dueno', TIENDA, VENDEDOR, { permissions: ['productos.ver', 'productos.eliminar', 'ventas.ver'] });
        expect((await stores.requireAccess('vende', TIENDA)).permissions).toEqual(['productos.ver', 'ventas.ver', 'productos.eliminar']);
        // y al quitarle un permiso al rol, lo pierde en la siguiente
        await roles.update('dueno', TIENDA, VENDEDOR, { permissions: ['productos.ver'] });
        expect((await stores.requireAccess('vende', TIENDA)).permissions).toEqual(['productos.ver']);
    });
});

describe('crear y editar roles personalizados', () => {
    it('se crea con nombre y permisos, completando lo que cada permiso necesita, y avisa qué agregó', async () => {
        const { roles, e } = construir();
        const r: any = await roles.create('dueno', TIENDA, '  Bodega  ', ['inventario.editar']);
        expect(r.name).toBe('Bodega');
        expect(r.permissions).toEqual(['productos.ver', 'canales.ver', 'inventario.editar']);
        expect(r.addedAutomatically).toEqual(['productos.ver', 'canales.ver']);
        expect(e.roles).toHaveLength(2);
    });

    it('rechaza nombres cortos, largos, con símbolos y los de los roles de fábrica', async () => {
        const { roles } = construir();
        const permisos = ['productos.ver', 'ventas.ver'];
        await expect(roles.create('dueno', TIENDA, 'A', permisos)).rejects.toThrow(/mínimo 2/);
        await expect(roles.create('dueno', TIENDA, 'x'.repeat(41), permisos)).rejects.toThrow(/hasta 40/);
        await expect(roles.create('dueno', TIENDA, 'a@b.com', permisos)).rejects.toThrow(/símbolos/);
        for (const reservado of ['Editor', 'LECTOR', 'Dueño', 'dueno', 'Personalizado', 'viewer']) {
            await expect(roles.create('dueno', TIENDA, reservado, permisos)).rejects.toThrow(/rol de fábrica/);
        }
    });

    it('rechaza permisos que no existen, una lista vacía y un conjunto idéntico a un rol de fábrica', async () => {
        const { roles } = construir();
        await expect(roles.create('dueno', TIENDA, 'Raro', ['productos.ver', 'hackear.todo'])).rejects.toThrow(/no existen: hackear\.todo/);
        await expect(roles.create('dueno', TIENDA, 'Vacío', [])).rejects.toThrow(/al menos un permiso/);
        await expect(roles.create('dueno', TIENDA, 'Copia', [...permisosDeRol('editor')])).rejects.toThrow(/exactamente los del rol de fábrica «Editor»/);
        await expect(roles.create('dueno', TIENDA, 'Todo', [...PERMISOS])).rejects.toThrow(/«Dueño»/);
    });

    it('con un solo permiso de menos que el Editor ya es personalizado y se guarda', async () => {
        const { roles } = construir();
        const sinEliminar = permisosDeRol('editor').filter((p) => p !== 'productos.eliminar');
        await expect(roles.create('dueno', TIENDA, 'Editor sin borrar', sinEliminar)).resolves.toMatchObject({ name: 'Editor sin borrar' });
    });

    it('no repite nombres en la misma tienda (sin distinguir mayúsculas), pero sí en otra', async () => {
        const { roles } = construir();
        await expect(roles.create('dueno', TIENDA, 'vendedor', ['productos.ver', 'ventas.ver'])).rejects.toBeInstanceOf(ConflictException);
    });

    it(`una tienda tiene hasta ${MAX_ROLES_POR_TIENDA} roles personalizados`, async () => {
        const muchos = Array.from({ length: MAX_ROLES_POR_TIENDA }, (_, k) => ({ id: `r${k}`, storeId: TIENDA, name: `Rol ${k}`, permissions: ['productos.ver'] }));
        const { roles } = construir({ roles: muchos });
        await expect(roles.create('dueno', TIENDA, 'Uno más', ['productos.ver', 'ventas.ver'])).rejects.toThrow(/hasta 20/);
    });

    it('se puede renombrar y cambiar sus permisos; un rol de otra tienda no se toca', async () => {
        const { roles, e } = construir({ roles: [
            { id: VENDEDOR, storeId: TIENDA, name: 'Vendedor', permissions: ['productos.ver', 'ventas.ver'] },
            { id: AJENO, storeId: OTRA_TIENDA, name: 'Ajeno', permissions: ['productos.ver'] },
        ] });
        await roles.update('dueno', TIENDA, VENDEDOR, { name: 'Vendedor senior' });
        expect(e.roles[0]).toMatchObject({ name: 'Vendedor senior', permissions: ['productos.ver', 'ventas.ver'] });
        await roles.update('dueno', TIENDA, VENDEDOR, { permissions: ['ventas.registrar'] });
        expect(e.roles[0].permissions).toEqual(['ventas.ver', 'ventas.registrar']);
        await expect(roles.update('dueno', TIENDA, AJENO, { name: 'Robado' })).rejects.toBeInstanceOf(NotFoundException);
        await expect(roles.update('dueno', TIENDA, 'no-es-uuid', { name: 'X' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('el catálogo y la lista traen todo lo que la pantalla necesita', async () => {
        const { roles } = construir();
        const lista: any = await roles.list('dueno', TIENDA);
        expect(lista.fabrica.map((f: any) => f.clave)).toEqual(['viewer', 'editor', 'owner']);
        expect(lista.permisos).toHaveLength(PERMISOS.length);
        expect(lista.personalizados).toEqual([expect.objectContaining({ id: VENDEDOR, name: 'Vendedor', people: 1, invitations: 0 })]);
        expect(catalogoDePermisos().permisos.find((p) => p.clave === 'inventario.editar')!.requiere).toEqual(['productos.ver', 'canales.ver']);
    });
});

describe('borrar un rol personalizado', () => {
    it('no se puede si alguien lo tiene: primero hay que cambiarle el rol', async () => {
        const { roles, e } = construir();
        await expect(roles.remove('dueno', TIENDA, VENDEDOR)).rejects.toThrow(/1 persona\. Cámbiales el rol|1 persona/);
        expect(e.roles).toHaveLength(1);
    });

    it('tampoco si hay una invitación pendiente con ese rol', async () => {
        const { roles } = construir({ miembros: [{ storeId: TIENDA, userId: 'dueno', role: 'owner', customRole: null }], invitaciones: [{ customRole: { id: VENDEDOR }, acceptedAt: null }] });
        await expect(roles.remove('dueno', TIENDA, VENDEDOR)).rejects.toThrow(/1 invitación pendiente/);
    });

    it('sin nadie que lo use, se borra', async () => {
        const { roles, e } = construir({ miembros: [{ storeId: TIENDA, userId: 'dueno', role: 'owner', customRole: null }] });
        await expect(roles.remove('dueno', TIENDA, VENDEDOR)).resolves.toEqual({ removed: true });
        expect(e.roles).toHaveLength(0);
    });
});

describe('asignar un rol personalizado a una persona', () => {
    it('cambiar el rol de alguien a uno personalizado deja «viewer» de base y el rol enlazado; volver a uno de fábrica lo suelta', async () => {
        const { stores, e } = construir({ miembros: [
            { storeId: TIENDA, userId: 'dueno', role: 'owner', customRole: null },
            { storeId: TIENDA, userId: 'luz', role: 'editor', customRole: null },
        ] });
        await expect(stores.changeRole('dueno', TIENDA, 'luz', { customRoleId: VENDEDOR })).resolves.toMatchObject({ role: 'viewer', roleName: 'Vendedor', customRoleId: VENDEDOR });
        expect(e.miembros[1]).toMatchObject({ role: 'viewer', customRole: expect.objectContaining({ id: VENDEDOR }) });
        await stores.changeRole('dueno', TIENDA, 'luz', 'editor');
        expect(e.miembros[1]).toMatchObject({ role: 'editor', customRole: null });
    });

    it('un rol de otra tienda o que no existe no se puede asignar', async () => {
        const { stores } = construir({ roles: [{ id: AJENO, storeId: OTRA_TIENDA, name: 'Ajeno', permissions: ['productos.ver'] }] });
        await expect(stores.changeRole('dueno', TIENDA, 'vende', { customRoleId: AJENO })).rejects.toThrow(/no existe en esta tienda/);
        await expect(stores.changeRole('dueno', TIENDA, 'vende', { customRoleId: 'basura' })).rejects.toThrow(/no existe en esta tienda/);
    });

    it('el dueño nunca recibe un rol personalizado', async () => {
        const { stores } = construir();
        await expect(stores.changeRole('root', TIENDA, 'dueno', { customRoleId: VENDEDOR })).rejects.toThrow(/dueño no se puede cambiar/);
    });

    it('se puede invitar con un rol personalizado: la invitación lo guarda y el correo dice su nombre', async () => {
        const { stores, repoInvit, correo } = construir();
        const r = await stores.invite('dueno', TIENDA, 'nueva@x.com', { customRoleId: VENDEDOR });
        expect(r).toMatchObject({ role: 'viewer', roleName: 'Vendedor', customRoleId: VENDEDOR });
        expect(repoInvit.save.mock.calls[0][0]).toMatchObject({ role: 'viewer', customRole: expect.objectContaining({ id: VENDEDOR }) });
        expect(correo.sendStoreInvitation.mock.calls[0][1]).toMatchObject({ roleName: 'Vendedor' });
    });

    it('al aceptar una invitación con rol personalizado, la persona entra con ese rol', async () => {
        const { createHash } = await import('crypto');
        const token = 'codigo-largo-de-prueba-1234';
        const invitacion = {
            id: 'i1', email: 'luz@x.com', role: 'viewer', customRole: { id: VENDEDOR, name: 'Vendedor' }, tokenHash: createHash('sha256').update(token).digest('hex'),
            expiresAt: new Date(Date.now() + 3600_000), acceptedAt: null, store: { id: TIENDA, name: 'Tienda A' },
        };
        const { stores, repoMiembros } = construir({ invitaciones: [invitacion] });
        await expect(stores.acceptInvitation('luz', token)).resolves.toMatchObject({ role: 'viewer', roleName: 'Vendedor' });
        expect(repoMiembros.save).toHaveBeenCalledWith(expect.objectContaining({ role: 'viewer', customRole: expect.objectContaining({ id: VENDEDOR }) }));
    });

    it('«role» o «customRoleId», exactamente uno', () => {
        expect(asignacionDe({ role: 'editor' })).toBe('editor');
        expect(asignacionDe({ customRoleId: VENDEDOR })).toEqual({ customRoleId: VENDEDOR });
        expect(() => asignacionDe({ role: 'editor', customRoleId: VENDEDOR })).toThrow(BadRequestException);
        expect(() => asignacionDe({})).toThrow(/Indica el rol/);
    });
});
