import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ApiKeysService, hashDeClave, MAX_CLAVES_ACTIVAS, PERMISOS_MCP, PERMISOS_MCP_POR_DEFECTO, permisosEfectivosDeClave, permisosParaClave } from './api-keys.service';
import { PERMISOS } from '../stores/permissions';

const TODOS = [...PERMISOS];

describe('permisos de una clave del MCP', () => {
    it('de escritura solo permite productos.editar', () => {
        for (const p of ['inventario.editar', 'canales.publicar', 'cambios.aprobar', 'productos.eliminar']) {
            expect(() => permisosParaClave([p], TODOS)).toThrow(BadRequestException);
        }
        expect(PERMISOS_MCP.filter((p) => !p.endsWith('.ver') && p !== 'ventas.contacto')).toEqual(['productos.editar']);
    });

    it('por defecto no lleva contacto de clientes ni costos', () => {
        const p = permisosParaClave(undefined, TODOS);
        expect(p).toEqual(expect.arrayContaining([...PERMISOS_MCP_POR_DEFECTO]));
        expect(p).not.toContain('ventas.contacto');
        expect(p).not.toContain('costos.ver');
    });

    it('agrega lo que cada permiso necesita', () => {
        expect(permisosParaClave(['ventas.contacto'], TODOS)).toEqual(expect.arrayContaining(['ventas.contacto', 'ventas.ver']));
    });

    it('no da a la clave permisos que quien la crea no tiene', () => {
        expect(() => permisosParaClave(['ventas.ver', 'ventas.contacto'], ['ventas.ver'])).toThrow(ForbiddenException);
    });

    it('rechaza una lista vacía o que no es lista', () => {
        expect(() => permisosParaClave([], TODOS)).toThrow(BadRequestException);
        expect(() => permisosParaClave('productos.ver', TODOS)).toThrow(BadRequestException);
    });

    it('los permisos efectivos son la intersección con los de quien la creó, siempre de lectura', () => {
        expect(permisosEfectivosDeClave(['productos.ver', 'ventas.ver'], ['productos.ver'])).toEqual(['productos.ver']);
        // Aunque una fila guardada llevara un permiso de escritura, nunca llega a ser efectivo.
        expect(permisosEfectivosDeClave(['productos.ver', 'inventario.editar'], TODOS)).toEqual(['productos.ver']);
    });
});

function montar(opts: { fila?: any; acceso?: any; accesoFalla?: boolean; activas?: number; usuario?: any } = {}) {
    const filas: any[] = [];
    const repo: any = {
        count: jest.fn().mockResolvedValue(opts.activas ?? 0),
        create: jest.fn((x) => x),
        save: jest.fn(async (x) => { const f = { id: 'k1', createdAt: new Date(), revokedAt: null, lastUsedAt: null, ...x }; filas.push(f); return f; }),
        findOne: jest.fn().mockResolvedValue(opts.fila ?? null),
        find: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue(undefined),
    };
    const stores: any = {
        requireAccess: jest.fn(async (_u, _s, minimo) => {
            if (opts.accesoFalla) throw new ForbiddenException('No tienes acceso a esta tienda.');
            const a = opts.acceso ?? { storeId: 's1', role: 'owner', permissions: TODOS };
            if (minimo === 'owner' && a.role !== 'owner') throw new ForbiddenException('Tu rol en esta tienda no permite esta acción.');
            return a;
        }),
    };
    const users: any = { findOne: jest.fn().mockResolvedValue(opts.usuario ?? { id: 'u1', role: 'admin', isActive: true }) };
    return { servicio: new ApiKeysService(repo, stores, users), repo, stores, users, filas };
}

describe('ApiKeysService.crear', () => {
    it('devuelve la clave una sola vez y guarda solo su hash', async () => {
        const { servicio, repo } = montar();
        const r = await servicio.crear('u1', 's1', { name: 'Claude de Pedro' });
        expect(r.key).toMatch(/^syk_[A-Za-z0-9_-]{40,}$/);
        const guardado = repo.save.mock.calls[0][0];
        expect(guardado.keyHash).toBe(hashDeClave(r.key));
        expect(JSON.stringify(guardado)).not.toContain(r.key);
        expect(guardado.prefix).toBe(r.key.slice(0, 12));
        expect(r).not.toHaveProperty('keyHash');
    });

    it('solo el dueño puede crear claves', async () => {
        const { servicio } = montar({ acceso: { storeId: 's1', role: 'editor', permissions: TODOS } });
        await expect(servicio.crear('u1', 's1', { name: 'Clave' })).rejects.toThrow(ForbiddenException);
    });

    it('valida el nombre, la caducidad y el máximo de claves activas', async () => {
        const { servicio } = montar();
        await expect(servicio.crear('u1', 's1', { name: 'a' })).rejects.toThrow(BadRequestException);
        await expect(servicio.crear('u1', 's1', { name: 'ok<>' })).rejects.toThrow(BadRequestException);
        await expect(servicio.crear('u1', 's1', { name: 'Clave', expiresInDays: 0 })).rejects.toThrow(BadRequestException);
        await expect(servicio.crear('u1', 's1', { name: 'Clave', expiresInDays: 9999 })).rejects.toThrow(BadRequestException);
        const lleno = montar({ activas: MAX_CLAVES_ACTIVAS });
        await expect(lleno.servicio.crear('u1', 's1', { name: 'Clave' })).rejects.toThrow(BadRequestException);
    });

    it('con caducidad guarda la fecha', async () => {
        const { servicio, repo } = montar();
        await servicio.crear('u1', 's1', { name: 'Clave', expiresInDays: 30 });
        expect(repo.save.mock.calls[0][0].expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
    });
});

describe('ApiKeysService.autenticar', () => {
    const CLAVE = 'syk_' + 'a'.repeat(43);
    const fila = (extra: any = {}) => ({
        id: 'k1', name: 'Clave', kind: 'store', keyHash: hashDeClave(CLAVE), permissions: ['productos.ver', 'ventas.ver', 'ventas.contacto'],
        expiresAt: null, revokedAt: null, lastUsedAt: null, store: { id: 's1' }, createdBy: { id: 'u1' }, ...extra,
    });

    it.each([
        ['con la sección Productos', { role: 'user', allowedSections: ['products'], isActive: true }, true],
        ['sin la sección Productos', { role: 'user', allowedSections: ['dashboard'], isActive: true }, false],
        ['desactivado', { role: 'user', allowedSections: [], isActive: false }, false],
    ])('escribir exige que su creador siga %s', async (_n, usuario, puede) => {
        const { servicio } = montar({ fila: fila({ permissions: ['productos.ver', 'productos.editar'] }), usuario });
        const a = await servicio.autenticar(CLAVE);
        expect(a.permissions.includes('productos.editar')).toBe(puede);
        expect(a.permissions).toContain('productos.ver');
    });

    it('acepta una clave válida y devuelve la tienda y los permisos efectivos', async () => {
        const { servicio } = montar({ fila: fila(), acceso: { storeId: 's1', role: 'viewer', permissions: ['productos.ver', 'ventas.ver'] } });
        const a = await servicio.autenticar(CLAVE);
        expect(a).toMatchObject({ storeId: 's1', userId: 'u1', role: 'viewer' });
        // La clave dice ventas.contacto, pero su creador (lector) no lo tiene: no llega.
        expect(a.permissions).toEqual(['productos.ver', 'ventas.ver']);
    });

    it.each([
        ['sin clave', undefined],
        ['con otro prefijo', 'Bearer abc'],
        ['demasiado larga', 'syk_' + 'a'.repeat(500)],
    ])('rechaza una clave %s', async (_n, clave) => {
        const { servicio, repo } = montar();
        await expect(servicio.autenticar(clave as any)).rejects.toThrow(UnauthorizedException);
        expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('rechaza una clave desconocida, revocada o caducada con el mismo mensaje', async () => {
        const mensajes = new Set<string>();
        for (const f of [null, fila({ revokedAt: new Date() }), fila({ expiresAt: new Date(Date.now() - 1000) })]) {
            const { servicio } = montar({ fila: f });
            await servicio.autenticar(CLAVE).catch((e) => { expect(e).toBeInstanceOf(UnauthorizedException); mensajes.add(e.message); });
        }
        expect(mensajes.size).toBe(1);
    });

    it('si su creador perdió todo lo que la clave permitía, lo dice con un 403 en vez de callar', async () => {
        const { servicio } = montar({ fila: fila(), acceso: { storeId: 's1', role: 'viewer', permissions: ['analiticas.ver'] } });
        await expect(servicio.autenticar(CLAVE)).rejects.toThrow(ForbiddenException);
    });

    it('si quien la creó ya no está en la tienda, la clave deja de servir', async () => {
        const { servicio } = montar({ fila: fila(), accesoFalla: true });
        await expect(servicio.autenticar(CLAVE)).rejects.toThrow(UnauthorizedException);
    });

    it('anota el último uso como mucho una vez por minuto', async () => {
        const reciente = montar({ fila: fila({ lastUsedAt: new Date() }) });
        await reciente.servicio.autenticar(CLAVE);
        expect(reciente.repo.update).not.toHaveBeenCalled();
        const vieja = montar({ fila: fila({ lastUsedAt: new Date(Date.now() - 120_000) }) });
        await vieja.servicio.autenticar(CLAVE);
        expect(vieja.repo.update).toHaveBeenCalled();
    });
});

describe('ApiKeysService.revocar', () => {
    it('revoca una clave de la tienda y falla si no existe', async () => {
        const ok = montar({ fila: { id: 'k1', revokedAt: null } });
        await expect(ok.servicio.revocar('u1', 's1', 'k1')).resolves.toEqual({ id: 'k1', revoked: true });
        expect(ok.repo.update).toHaveBeenCalledWith({ id: 'k1' }, { revokedAt: expect.any(Date) });
        const no = montar();
        await expect(no.servicio.revocar('u1', 's1', 'x')).rejects.toThrow('Clave no encontrada.');
    });
});
