import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { StoresService } from './stores.service';

/**
 * Lo que se protege: que nadie entre a una tienda a la que no lo invitaron,
 * que una invitación sirva una sola vez y solo para su correo, y que el enlace
 * público no revele nada más que cifras generales.
 */

const STORE_A = '11111111-1111-1111-1111-111111111111';
const STORE_B = '22222222-2222-2222-2222-222222222222';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

function construir(estado: {
    usuarios?: Record<string, any>;
    miembros?: { storeId: string; userId: string; role: string }[];
    tiendas?: any[];
    invitaciones?: any[];
    enlaces?: any[];
} = {}) {
    const usuarios = estado.usuarios ?? {};
    const miembros = estado.miembros ?? [];
    const tiendas = estado.tiendas ?? [];
    const invitaciones = estado.invitaciones ?? [];

    const repoUsuarios = { findOne: jest.fn(async ({ where }: any) => usuarios[where.id] ?? null), update: jest.fn() };
    const repoTiendas = {
        exist: jest.fn(async ({ where }: any) => tiendas.some(t => t.id === where.id)),
        findOne: jest.fn(async ({ where }: any) =>
            tiendas.find(t =>
                (where.id === undefined || t.id === where.id) &&
                (where.publicToken === undefined || t.publicToken === where.publicToken) &&
                (where.publicEnabled === undefined || t.publicEnabled === where.publicEnabled)) ?? null),
        save: jest.fn(async (t: any) => t),
        update: jest.fn(),
        create: jest.fn((d: any) => ({ id: 'nueva', ...d })),
    };
    const repoMiembros = {
        findOne: jest.fn(async ({ where }: any) => {
            // Se puede buscar al miembro por id de usuario o por su correo.
            const porCorreo = where.user?.email
                ? Object.values(usuarios).find((u: any) => u.email === where.user.email)?.id
                : undefined;
            if (where.user?.email && !porCorreo) return null;
            return miembros.find(m =>
                m.storeId === where.store?.id &&
                (where.user?.id ? m.userId === where.user.id : porCorreo ? m.userId === porCorreo : true)) ?? null;
        }),
        exist: jest.fn(async ({ where }: any) => miembros.some(m => m.userId === where.user?.id)),
        find: jest.fn(async () => []),
        save: jest.fn(async (m: any) => m),
        create: jest.fn((d: any) => d),
    };
    const repoInvit = {
        findOne: jest.fn(async ({ where }: any) => invitaciones.find(i => i.tokenHash === where.tokenHash) ?? null),
        update: jest.fn(async () => ({ affected: 1 })),
        exist: jest.fn(async ({ where }: any) => invitaciones.some(i => i.email === where.email && !i.acceptedAt && i.expiresAt > new Date())),
        delete: jest.fn(async () => ({ affected: 1 })),
        save: jest.fn(async (i: any) => i),
        create: jest.fn((d: any) => d),
    };
    const repoEnlaces = { find: jest.fn(async () => estado.enlaces ?? []) };
    const correo = { sendStoreInvitation: jest.fn().mockResolvedValue(undefined) };

    const service = new StoresService(
        repoTiendas as any, repoMiembros as any, repoInvit as any,
        repoUsuarios as any, repoEnlaces as any, correo as any,
    );
    return { service, repoMiembros, repoInvit, repoTiendas, repoUsuarios, correo };
}

describe('acceso a una tienda', () => {
    const base = {
        usuarios: { ana: { id: 'ana', role: 'user' }, beto: { id: 'beto', role: 'user' }, root: { id: 'root', role: 'admin' } },
        tiendas: [{ id: STORE_A }, { id: STORE_B }],
        miembros: [
            { storeId: STORE_A, userId: 'ana', role: 'owner' },
            { storeId: STORE_A, userId: 'beto', role: 'viewer' },
        ],
    };

    it('un miembro entra con su rol', async () => {
        const { service } = construir(base);
        await expect(service.requireAccess('beto', STORE_A)).resolves.toEqual({ storeId: STORE_A, role: 'viewer' });
    });

    it('quien no es miembro recibe «No tienes acceso a esta tienda»', async () => {
        const { service } = construir(base);
        await expect(service.requireAccess('ana', STORE_B)).rejects.toThrow('No tienes acceso a esta tienda.');
    });

    it('una tienda que no existe responde igual que una ajena', async () => {
        const { service } = construir(base);
        const ajena = await service.requireAccess('ana', STORE_B).catch(e => e.message);
        const inexistente = await service.requireAccess('ana', '33333333-3333-3333-3333-333333333333').catch(e => e.message);
        expect(inexistente).toBe(ajena);
    });

    it('un id mal formado no llega a la base de datos', async () => {
        const { service, repoMiembros } = construir(base);
        await expect(service.requireAccess('ana', "x' OR '1'='1")).rejects.toBeInstanceOf(ForbiddenException);
        expect(repoMiembros.findOne).not.toHaveBeenCalled();
    });

    it('un lector no puede hacer lo que pide rol de dueño', async () => {
        const { service } = construir(base);
        await expect(service.requireAccess('beto', STORE_A, 'owner')).rejects.toThrow(/rol/);
        await expect(service.requireAccess('beto', STORE_A, 'editor')).rejects.toThrow(/rol/);
    });

    it('el administrador de la agencia entra a cualquier tienda existente como dueño', async () => {
        const { service } = construir(base);
        await expect(service.requireAccess('root', STORE_B, 'owner')).resolves.toEqual({ storeId: STORE_B, role: 'owner' });
    });
});

describe('invitaciones', () => {
    const base = {
        usuarios: { ana: { id: 'ana', role: 'user', email: 'ana@x.com' }, luz: { id: 'luz', role: 'user', email: 'luz@x.com' } },
        tiendas: [{ id: STORE_A, name: 'Tienda A' }],
        miembros: [{ storeId: STORE_A, userId: 'ana', role: 'owner' }],
    };

    it('solo el dueño invita', async () => {
        const { service } = construir({ ...base, miembros: [{ storeId: STORE_A, userId: 'luz', role: 'editor' }] });
        await expect(service.invite('luz', STORE_A, 'otro@x.com', 'viewer')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('guarda solo el hash del código y manda el código por correo', async () => {
        const { service, repoInvit, correo } = construir(base);
        await service.invite('ana', STORE_A, ' Luz@X.com ', 'editor');

        const guardada = repoInvit.save.mock.calls[0][0];
        const enviado = correo.sendStoreInvitation.mock.calls[0];
        expect(guardada.email).toBe('luz@x.com');
        expect(enviado[1].token).toBeTruthy();
        expect(guardada.tokenHash).toBe(sha(enviado[1].token));
        expect(JSON.stringify(guardada)).not.toContain(enviado[1].token);
    });

    it('rechaza un correo inválido', async () => {
        const { service } = construir(base);
        await expect(service.invite('ana', STORE_A, 'no-es-correo', 'viewer')).rejects.toBeInstanceOf(BadRequestException);
    });

    const invitacion = (over: any = {}) => ({
        id: 'i1', email: 'luz@x.com', role: 'editor', tokenHash: sha('codigo-largo-de-prueba-1234'),
        expiresAt: new Date(Date.now() + 3600_000), acceptedAt: null, store: { id: STORE_A, name: 'Tienda A' }, ...over,
    });

    it('acepta con el correo correcto y crea la membresía con el rol invitado', async () => {
        const { service, repoMiembros } = construir({ ...base, invitaciones: [invitacion()] });
        await expect(service.acceptInvitation('luz', 'codigo-largo-de-prueba-1234')).resolves.toMatchObject({ storeId: STORE_A, role: 'editor' });
        expect(repoMiembros.save).toHaveBeenCalledWith(expect.objectContaining({ role: 'editor' }));
    });

    it('si el enlace llega a otra persona, esa persona no entra', async () => {
        const { service, repoMiembros } = construir({ ...base, invitaciones: [invitacion()] });
        await expect(service.acceptInvitation('ana', 'codigo-largo-de-prueba-1234')).rejects.toBeInstanceOf(ForbiddenException);
        expect(repoMiembros.save).not.toHaveBeenCalled();
    });

    it('una invitación caducada o ya usada no sirve', async () => {
        const vencida = construir({ ...base, invitaciones: [invitacion({ expiresAt: new Date(Date.now() - 1000) })] });
        await expect(vencida.service.acceptInvitation('luz', 'codigo-largo-de-prueba-1234')).rejects.toBeInstanceOf(BadRequestException);

        const usada = construir({ ...base, invitaciones: [invitacion({ acceptedAt: new Date() })] });
        await expect(usada.service.acceptInvitation('luz', 'codigo-largo-de-prueba-1234')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('dos clics seguidos no crean dos membresías', async () => {
        const { service, repoInvit, repoMiembros } = construir({ ...base, invitaciones: [invitacion()] });
        repoInvit.update.mockResolvedValue({ affected: 0 });
        await expect(service.acceptInvitation('luz', 'codigo-largo-de-prueba-1234')).rejects.toBeInstanceOf(BadRequestException);
        expect(repoMiembros.save).not.toHaveBeenCalled();
    });

    it('un código inventado no sirve', async () => {
        const { service } = construir({ ...base, invitaciones: [invitacion()] });
        await expect(service.acceptInvitation('luz', 'otro-codigo-cualquiera-12345')).rejects.toBeInstanceOf(BadRequestException);
    });
});

describe('enlace público', () => {
    const tienda = (over: any = {}) => ({
        id: STORE_A, name: 'Rivesi Home', publicToken: 'a'.repeat(32), publicEnabled: true, owner: { id: 'ana' }, ...over,
    });

    it('muestra solo cifras generales', async () => {
        const { service } = construir({
            tiendas: [tienda()],
            enlaces: [
                { marketplace: 'falabella', syncStatus: 'published', qualityScore: 100 },
                { marketplace: 'falabella', syncStatus: 'paused', qualityScore: 90 },
                { marketplace: 'mercadolibre', syncStatus: 'published', qualityScore: null },
            ],
        });
        const resumen = await service.publicSummary('a'.repeat(32));
        expect(resumen).toEqual({
            name: 'Rivesi Home',
            channels: ['falabella', 'mercadolibre'],
            publications: 3,
            byStatus: { published: 2, paused: 1 },
            averageQuality: 95,
        });
        // Nada que identifique al dueño ni datos comerciales.
        expect(Object.keys(resumen)).not.toEqual(expect.arrayContaining(['owner', 'price', 'stock', 'orders']));
    });

    it('apagado o con un código distinto responde igual: no disponible', async () => {
        const apagado = construir({ tiendas: [tienda({ publicEnabled: false })] });
        await expect(apagado.service.publicSummary('a'.repeat(32))).rejects.toBeInstanceOf(NotFoundException);

        const otro = construir({ tiendas: [tienda()] });
        await expect(otro.service.publicSummary('b'.repeat(32))).rejects.toBeInstanceOf(NotFoundException);
    });

    it('un código demasiado corto ni se busca', async () => {
        const { service, repoTiendas } = construir({ tiendas: [tienda()] });
        await expect(service.publicSummary('abc')).rejects.toBeInstanceOf(NotFoundException);
        expect(repoTiendas.findOne).not.toHaveBeenCalled();
    });

    it('al activarlo se crea un código largo; regenerar lo cambia', async () => {
        const base = {
            usuarios: { ana: { id: 'ana', role: 'user' } },
            miembros: [{ storeId: STORE_A, userId: 'ana', role: 'owner' }],
        };
        const { service } = construir({ ...base, tiendas: [tienda({ publicToken: null, publicEnabled: false })] });
        const primero = await service.setPublicLink('ana', STORE_A, true);
        expect(primero.publicEnabled).toBe(true);
        expect(primero.url).toMatch(/\/t\/[A-Za-z0-9_-]{30,}$/);

        const otro = await service.setPublicLink('ana', STORE_A, true, true);
        expect(otro.url).not.toBe(primero.url);

        const apagado = await service.setPublicLink('ana', STORE_A, false);
        expect(apagado).toEqual({ publicEnabled: false, url: null });
    });
});

describe('quién puede crear tiendas', () => {
    const usuarios = {
        propio: { id: 'propio', role: 'user', createdFromInvitation: false, name: 'Ana', lastName: 'Ruiz', nameCompany: 'Rivesi Home' },
        invitado: { id: 'invitado', role: 'user', createdFromInvitation: true, name: 'Luz', lastName: 'M' },
        root: { id: 'root', role: 'admin', createdFromInvitation: true },
    };

    it('quien se registró por su cuenta puede crear tiendas', async () => {
        const { service, repoTiendas } = construir({ usuarios });
        await expect(service.create('propio', 'Mi segunda tienda')).resolves.toMatchObject({ name: 'Mi segunda tienda', role: 'owner' });
        expect(repoTiendas.save).toHaveBeenCalled();
    });

    it('una cuenta nacida de una invitación NO puede crear tiendas', async () => {
        const { service, repoTiendas } = construir({ usuarios });
        await expect(service.create('invitado', 'Intento')).rejects.toThrow(/por invitación/i);
        expect(repoTiendas.save).not.toHaveBeenCalled();
    });

    it('el administrador de la agencia siempre puede', async () => {
        const { service } = construir({ usuarios });
        await expect(service.canCreateStores('root')).resolves.toBe(true);
    });

    it('al registrarse con un correo invitado, la cuenta se marca como invitada', async () => {
        const { service, repoUsuarios } = construir({
            usuarios,
            invitaciones: [{ email: 'luz@x.com', acceptedAt: null, expiresAt: new Date(Date.now() + 3600_000), tokenHash: 'x' }],
        });
        await expect(service.flagIfInvited('invitado', ' Luz@X.com ')).resolves.toBe(true);
        expect(repoUsuarios.update).toHaveBeenCalledWith({ id: 'invitado' }, { createdFromInvitation: true });
    });

    it('sin invitación vigente, o con una caducada, la cuenta no se marca', async () => {
        const sin = construir({ usuarios });
        await expect(sin.service.flagIfInvited('propio', 'ana@x.com')).resolves.toBe(false);
        expect(sin.repoUsuarios.update).not.toHaveBeenCalled();

        const vencida = construir({
            usuarios,
            invitaciones: [{ email: 'ana@x.com', acceptedAt: null, expiresAt: new Date(Date.now() - 1000), tokenHash: 'x' }],
        });
        await expect(vencida.service.flagIfInvited('propio', 'ana@x.com')).resolves.toBe(false);
    });

    it('quien se registró solo recibe su tienda; el invitado no recibe ninguna', async () => {
        const propio = construir({ usuarios });
        const lista = await propio.service.listMine('propio');
        expect(propio.repoTiendas.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'Rivesi Home' }));
        expect(lista.canCreateStores).toBe(true);

        const invitado = construir({ usuarios });
        const suya = await invitado.service.listMine('invitado');
        expect(invitado.repoTiendas.save).not.toHaveBeenCalled();
        expect(suya.stores).toEqual([]);
        expect(suya.canCreateStores).toBe(false);
    });
});
