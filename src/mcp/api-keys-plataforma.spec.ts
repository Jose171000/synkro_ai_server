import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ApiKeysService, hashDeClave, MAX_CLAVES_PLATAFORMA_ACTIVAS, MAX_DIAS_PLATAFORMA, permisosParaClavePlataforma, PREFIJO_PLATAFORMA } from './api-keys.service';
import { permisosDeTiendaParaPlataforma, PERMISOS_PLATAFORMA } from './permisos-plataforma';

describe('permisos de una clave de plataforma', () => {
    it('por defecto solo lleva clientes', () => {
        expect(permisosParaClavePlataforma(undefined)).toEqual(['clientes.ver']);
    });

    it('finanzas arrastra a clientes: los costos no sirven sin poder ver las tiendas', () => {
        expect(permisosParaClavePlataforma(['finanzas.ver'])).toEqual(['clientes.ver', 'finanzas.ver']);
    });

    it('rechaza lo que no existe (incluida la actividad de usuarios y cualquier permiso de escritura)', () => {
        for (const p of ['actividad.ver', 'productos.editar', 'clientes.editar', 'admin']) {
            expect(() => permisosParaClavePlataforma([p])).toThrow(BadRequestException);
        }
        expect(PERMISOS_PLATAFORMA as readonly string[]).not.toContain('actividad.ver');
        expect(() => permisosParaClavePlataforma([])).toThrow(BadRequestException);
        expect(() => permisosParaClavePlataforma('clientes.ver')).toThrow(BadRequestException);
    });

    it('dentro de cada tienda nunca da el contacto de los compradores', () => {
        const dentro = permisosDeTiendaParaPlataforma(['clientes.ver', 'finanzas.ver', 'sistema.ver']);
        expect(dentro).toEqual(expect.arrayContaining(['productos.ver', 'ventas.ver', 'analiticas.ver', 'costos.ver']));
        expect(dentro).not.toContain('ventas.contacto');
        expect(permisosDeTiendaParaPlataforma(['sistema.ver'])).toEqual([]);
        expect(permisosDeTiendaParaPlataforma(['clientes.ver'])).not.toContain('costos.ver');
    });
});

function montar(opts: { fila?: any; usuario?: any; activas?: number; filas?: any[] } = {}) {
    const repo: any = {
        count: jest.fn().mockResolvedValue(opts.activas ?? 0),
        create: jest.fn((x) => x),
        save: jest.fn(async (x) => ({ id: 'k1', createdAt: new Date(), revokedAt: null, lastUsedAt: null, ...x })),
        findOne: jest.fn().mockResolvedValue(opts.fila ?? null),
        update: jest.fn().mockResolvedValue(undefined),
        createQueryBuilder: jest.fn(),
    };
    const qb: any = {};
    for (const m of ['leftJoin', 'addSelect', 'orderBy', 'andWhere']) qb[m] = jest.fn(() => qb);
    qb.getMany = jest.fn().mockResolvedValue(opts.filas ?? []);
    repo.createQueryBuilder.mockReturnValue(qb);
    const users: any = { findOne: jest.fn().mockResolvedValue(opts.usuario === undefined ? { id: 'admin1', role: 'admin', isActive: true } : opts.usuario) };
    const stores: any = { requireAccess: jest.fn() };
    return { servicio: new ApiKeysService(repo, stores, users), repo, users, qb };
}

describe('ApiKeysService.crearPlataforma', () => {
    it('crea una clave sya_ sin tienda, con hash, y caduca', async () => {
        const { servicio, repo } = montar();
        const r = await servicio.crearPlataforma('admin1', { name: 'Claude de la agencia', permissions: ['clientes.ver', 'finanzas.ver'], expiresInDays: 30 });
        expect(r.key.startsWith(PREFIJO_PLATAFORMA)).toBe(true);
        const g = repo.save.mock.calls[0][0];
        expect(g).toMatchObject({ kind: 'platform', store: null, keyHash: hashDeClave(r.key), permissions: ['clientes.ver', 'finanzas.ver'] });
        expect(g.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 86400000);
        expect(JSON.stringify(g)).not.toContain(r.key);
    });

    it('solo un superadmin puede crearla: el rol se lee de la base, no del token', async () => {
        for (const usuario of [{ id: 'u', role: 'user', isActive: true }, { id: 'u', role: 'contador', isActive: true }, { id: 'u', role: 'admin', isActive: false }, null]) {
            const { servicio, repo } = montar({ usuario });
            await expect(servicio.crearPlataforma('u', { name: 'Clave', expiresInDays: 10 })).rejects.toThrow(ForbiddenException);
            expect(repo.save).not.toHaveBeenCalled();
        }
    });

    it('la caducidad es obligatoria y de 90 días como máximo', async () => {
        const { servicio } = montar();
        await expect(servicio.crearPlataforma('admin1', { name: 'Clave' })).rejects.toThrow(/debe caducar/);
        await expect(servicio.crearPlataforma('admin1', { name: 'Clave', expiresInDays: MAX_DIAS_PLATAFORMA + 1 })).rejects.toThrow(BadRequestException);
        await expect(servicio.crearPlataforma('admin1', { name: 'Clave', expiresInDays: 0 })).rejects.toThrow(BadRequestException);
        await expect(servicio.crearPlataforma('admin1', { name: 'Clave', expiresInDays: MAX_DIAS_PLATAFORMA })).resolves.toBeDefined();
    });

    it('tiene un tope de claves activas', async () => {
        const { servicio } = montar({ activas: MAX_CLAVES_PLATAFORMA_ACTIVAS });
        await expect(servicio.crearPlataforma('admin1', { name: 'Clave', expiresInDays: 10 })).rejects.toThrow(/hasta 20 claves/);
    });
});

describe('ApiKeysService.autenticarPlataforma', () => {
    const CLAVE = PREFIJO_PLATAFORMA + 'b'.repeat(43);
    const fila = (extra: any = {}) => ({
        id: 'k1', name: 'Agencia', kind: 'platform', keyHash: hashDeClave(CLAVE), permissions: ['clientes.ver', 'finanzas.ver'],
        expiresAt: new Date(Date.now() + 86400000), revokedAt: null, lastUsedAt: null, createdBy: { id: 'admin1' }, ...extra,
    });

    it('acepta una clave válida de un superadmin activo', async () => {
        const { servicio } = montar({ fila: fila() });
        expect(await servicio.autenticarPlataforma(CLAVE)).toEqual({ keyId: 'k1', keyName: 'Agencia', userId: 'admin1', permissions: ['clientes.ver', 'finanzas.ver'] });
    });

    it('una clave de tienda no sirve aquí, ni una de plataforma en el MCP de tienda', async () => {
        const { servicio, repo } = montar({ fila: fila() });
        await expect(servicio.autenticarPlataforma('syk_' + 'c'.repeat(43))).rejects.toThrow(UnauthorizedException);
        expect(repo.findOne).not.toHaveBeenCalled();
        await expect(servicio.autenticar(CLAVE)).rejects.toThrow(UnauthorizedException);
        // Aunque alguien guardara una fila «store» con prefijo sya_, el tipo manda.
        const tienda = montar({ fila: fila({ kind: 'store' }) });
        await expect(tienda.servicio.autenticarPlataforma(CLAVE)).rejects.toThrow(UnauthorizedException);
    });

    it.each([
        ['revocada', { revokedAt: new Date() }],
        ['caducada', { expiresAt: new Date(Date.now() - 1000) }],
        ['sin caducidad (no debería existir)', { expiresAt: null }],
    ])('rechaza una clave %s', async (_n, extra) => {
        const { servicio } = montar({ fila: fila(extra) });
        await expect(servicio.autenticarPlataforma(CLAVE)).rejects.toThrow('Clave inválida, caducada o revocada.');
    });

    it('si quien la creó ya no es superadmin (o está desactivado), la clave muere al instante', async () => {
        for (const usuario of [{ id: 'admin1', role: 'user', isActive: true }, { id: 'admin1', role: 'contador', isActive: true }, { id: 'admin1', role: 'admin', isActive: false }, null]) {
            const { servicio } = montar({ fila: fila(), usuario });
            await expect(servicio.autenticarPlataforma(CLAVE)).rejects.toThrow(UnauthorizedException);
        }
    });

    it('ignora permisos que no existen en la fila', async () => {
        const { servicio } = montar({ fila: fila({ permissions: ['actividad.ver', 'sistema.ver'] }) });
        expect((await servicio.autenticarPlataforma(CLAVE)).permissions).toEqual(['sistema.ver']);
        const vacia = montar({ fila: fila({ permissions: ['actividad.ver'] }) });
        await expect(vacia.servicio.autenticarPlataforma(CLAVE)).rejects.toThrow(ForbiddenException);
    });
});

describe('vista y control de superadmin', () => {
    it('listarTodas y revocarComoSuperadmin exigen ser superadmin', async () => {
        const { servicio, repo } = montar({ usuario: { id: 'u', role: 'user', isActive: true } });
        await expect(servicio.listarTodas('u')).rejects.toThrow(ForbiddenException);
        await expect(servicio.revocarComoSuperadmin('u', 'k1')).rejects.toThrow(ForbiddenException);
        expect(repo.update).not.toHaveBeenCalled();
    });

    it('lista todas con su tienda y su creador, sin clave ni hash', async () => {
        const hoy = new Date();
        const { servicio, qb } = montar({ filas: [
            { id: 'a', kind: 'store', name: 'De tienda', prefix: 'syk_aaaa', permissions: ['productos.ver'], keyHash: 'SECRETO', expiresAt: null, revokedAt: null, lastUsedAt: null, createdAt: hoy,
              store: { id: 's1', name: 'Joli Joli' }, createdBy: { id: 'u1', email: 'jj@x.com', name: 'Ana', lastName: 'Ruiz' } },
            { id: 'b', kind: 'platform', name: 'Agencia', prefix: 'sya_bbbb', permissions: ['clientes.ver'], keyHash: 'SECRETO', expiresAt: new Date(Date.now() - 1000), revokedAt: null, lastUsedAt: null, createdAt: hoy,
              store: null, createdBy: { id: 'admin1', email: 'a@x.com', name: 'Su', lastName: 'Per' } },
        ] });
        const r = await servicio.listarTodas('admin1', { estado: 'activa', kind: 'store' });
        expect(r).toHaveLength(2);
        expect(r[0]).toMatchObject({ kind: 'store', estado: 'activa', store: { id: 's1', name: 'Joli Joli' }, createdBy: { email: 'jj@x.com', name: 'Ana Ruiz' } });
        expect(r[1]).toMatchObject({ kind: 'platform', estado: 'caducada', store: null });
        expect(JSON.stringify(r)).not.toMatch(/SECRETO|keyHash/);
        expect(qb.andWhere).toHaveBeenCalledTimes(2);
    });

    it('valida los filtros', async () => {
        const { servicio } = montar();
        await expect(servicio.listarTodas('admin1', { kind: 'otro' as any })).rejects.toThrow(BadRequestException);
        await expect(servicio.listarTodas('admin1', { estado: 'x' as any })).rejects.toThrow(BadRequestException);
    });

    it('un superadmin revoca cualquier clave, de cualquier tienda', async () => {
        const { servicio, repo } = montar({ fila: { id: 'k9', name: 'Ajena', kind: 'store', revokedAt: null, createdBy: { id: 'u7' }, store: { id: 's3' } } });
        await expect(servicio.revocarComoSuperadmin('admin1', 'k9')).resolves.toEqual({ id: 'k9', revoked: true });
        expect(repo.update).toHaveBeenCalledWith({ id: 'k9' }, { revokedAt: expect.any(Date) });
        const no = montar();
        await expect(no.servicio.revocarComoSuperadmin('admin1', 'zz')).rejects.toThrow('Clave no encontrada.');
    });
});
