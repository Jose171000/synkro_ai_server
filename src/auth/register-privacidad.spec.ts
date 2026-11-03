process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test';
import { BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';

/**
 * El aviso de privacidad es condición para crear la cuenta, tanto de una tienda independiente como de una persona invitada.
 * Se exige cuando el servidor lo activa (PRIVACY_CONSENT_REQUIRED=true), y queda constancia de la aceptación y de la vía.
 */
function construir(opciones: { invitacion?: any } = {}) {
    const usuario: any = { id: 'u1', email: 'luz@x.com', name: 'Luz', lastName: 'Paz', approvalStatus: 'pending', role: 'user' };
    const userService: any = {
        findByEmail: jest.fn(async () => null),
        createUser: jest.fn(async (_d: any, estado: any) => { Object.assign(usuario, estado); return usuario; }),
        findAdminEmails: jest.fn(async () => ['admin@x.com']),
        setApproval: jest.fn(),
    };
    const storesService: any = {
        invitacionParaRegistro: jest.fn(async () => opciones.invitacion ?? null),
        flagIfInvited: jest.fn(async () => true),
        acceptInvitation: jest.fn(async () => ({ storeId: 's1', name: 'Tienda A', role: 'editor' })),
    };
    const profileRepository: any = { create: jest.fn((x: any) => x), save: jest.fn(async (x: any) => x) };
    const mailService: any = {
        sendSignupRequestToAdmins: jest.fn().mockResolvedValue(undefined),
        sendSignupReceived: jest.fn().mockResolvedValue(undefined),
        sendWelcome: jest.fn().mockResolvedValue(undefined),
    };
    const privacy: any = { aceptar: jest.fn(async () => undefined) };
    const activity: any = { anotar: jest.fn(async () => undefined) };
    const svc: any = new AuthService(userService, {} as any, {} as any, mailService, storesService, {} as any, {} as any, profileRepository, privacy, activity);
    svc.generateTokens = jest.fn(async () => ({ accessToken: 'a', refreshToken: 'r' }));
    svc.sanitizeUser = (u: any) => u;
    return { svc, userService, privacy, activity };
}

const tienda = { name: 'Luz', lastName: 'Paz', email: 'luz@x.com', password: 'clave-larga-1', nameCompany: 'Mi tienda', ruc: '20123456789', businessName: 'Mi tienda SAC' } as any;
const invitada = { name: 'Luz', lastName: 'Paz', email: 'luz@x.com', password: 'clave-larga-1', invitationToken: 'codigo' } as any;
const invitacion = { email: 'luz@x.com', role: 'editor', store: { id: 's1', name: 'Tienda A' } };

describe('aviso de privacidad al crear la cuenta', () => {
    afterEach(() => { delete process.env.PRIVACY_CONSENT_REQUIRED; });

    it('con el aviso exigido, sin la casilla marcada no se crea ni una tienda independiente ni una cuenta invitada', async () => {
        process.env.PRIVACY_CONSENT_REQUIRED = 'true';
        const a = construir();
        await expect(a.svc.register(tienda)).rejects.toThrow(BadRequestException);
        await expect(a.svc.register({ ...tienda, acceptPrivacy: false })).rejects.toThrow(/aviso de privacidad/);
        expect(a.userService.createUser).not.toHaveBeenCalled();
        const b = construir({ invitacion });
        await expect(b.svc.register(invitada)).rejects.toThrow(/aviso de privacidad/);
        expect(b.userService.createUser).not.toHaveBeenCalled();
    });

    it('con la casilla marcada queda constancia, y la vía es «registro» o «invitacion» según el caso', async () => {
        process.env.PRIVACY_CONSENT_REQUIRED = 'true';
        const a = construir();
        await a.svc.register({ ...tienda, acceptPrivacy: true });
        expect(a.privacy.aceptar).toHaveBeenCalledWith('u1', 'registro');
        const b = construir({ invitacion });
        await b.svc.register({ ...invitada, acceptPrivacy: true });
        expect(b.privacy.aceptar).toHaveBeenCalledWith('u1', 'invitacion');
    });

    it('mientras el servidor no lo exige, el formulario anterior (sin casilla) sigue funcionando y no se guarda aceptación', async () => {
        const a = construir();
        await a.svc.register(tienda);
        expect(a.userService.createUser).toHaveBeenCalled();
        expect(a.privacy.aceptar).not.toHaveBeenCalled();
    });

    it('si guardar la aceptación falla, el registro igual se completa', async () => {
        const a = construir();
        a.privacy.aceptar.mockRejectedValue(new Error('base caída'));
        await expect(a.svc.register({ ...tienda, acceptPrivacy: true })).resolves.toBeDefined();
    });
});

describe('ingreso para el registro de actividad', () => {
    it('al iniciar sesión se anota el ingreso, sin esperar ni poder romper el inicio de sesión', async () => {
        const a = construir();
        const usuario: any = { id: 'u1', email: 'luz@x.com', role: 'user', password: await require('bcryptjs').hash('clave-larga-1', 4), approvalStatus: 'approved', isActive: true };
        a.userService.findByEmail = jest.fn(async () => usuario);
        a.svc.asegurarAprobada = jest.fn();
        const r = await a.svc.login({ email: 'luz@x.com', password: 'clave-larga-1' });
        expect(r.accessToken).toBe('a');
        expect(a.activity.anotar).toHaveBeenCalledWith({ userId: 'u1', platformRole: 'user' }, 'login', 'Inicio de sesión', 'cuenta');
    });
});
