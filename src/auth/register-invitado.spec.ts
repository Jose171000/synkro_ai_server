process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test';
import { BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';

/**
 * Una persona invitada al equipo de una tienda no es un cliente nuevo: no da datos de empresa, no se crea su perfil
 * comercial, no espera aprobación y entra con la tienda ya activa. Saltarse la aprobación exige el código de la invitación.
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
    const svc: any = new AuthService(userService, {} as any, {} as any, mailService, storesService, {} as any, {} as any, profileRepository);
    svc.generateTokens = jest.fn(async () => ({ accessToken: 'a', refreshToken: 'r' }));
    svc.sanitizeUser = (u: any) => u;
    return { svc, userService, storesService, profileRepository, mailService, usuario };
}

const basico = { name: 'Luz', lastName: 'Paz', email: 'luz@x.com', password: 'clave-larga-1' } as any;

describe('registro con invitación', () => {
    const invitacion = { email: 'luz@x.com', role: 'editor', store: { id: 's1', name: 'Tienda A' } };

    it('entra aprobada, sin perfil de empresa y con la tienda ya aceptada', async () => {
        const { svc, userService, storesService, profileRepository } = construir({ invitacion });
        const r = await svc.register({ ...basico, invitationToken: 'codigo' });
        expect(userService.createUser).toHaveBeenCalledWith(expect.objectContaining({ nameCompany: 'Tienda A' }), expect.objectContaining({ approvalStatus: 'approved' }));
        expect(profileRepository.save).not.toHaveBeenCalled();
        expect(storesService.acceptInvitation).toHaveBeenCalledWith('u1', 'codigo');
        expect(r).toMatchObject({ accessToken: 'a', invitedStore: { storeId: 's1', name: 'Tienda A' } });
        expect((r as any).pending).toBeUndefined();
    });

    it('con un código que no vale (o de otro correo) no se registra', async () => {
        const { svc, userService } = construir({ invitacion: null });
        await expect(svc.register({ ...basico, invitationToken: 'malo' })).rejects.toBeInstanceOf(BadRequestException);
        expect(userService.createUser).not.toHaveBeenCalled();
    });

    it('sin código, aunque el correo tenga una invitación, espera la aprobación como todos', async () => {
        const { svc, userService, profileRepository, mailService } = construir({ invitacion: null });
        const r = await svc.register({ ...basico, nameCompany: 'Mi Tienda', ruc: '20123456789', businessName: 'Mi Tienda SAC' });
        expect(userService.createUser).toHaveBeenCalledWith(expect.anything(), { approvalStatus: 'pending' });
        expect(userService.setApproval).not.toHaveBeenCalled();
        expect(profileRepository.save).toHaveBeenCalled();
        expect(r).toMatchObject({ pending: true });
        expect(mailService.sendSignupRequestToAdmins).toHaveBeenCalled();
    });
});
