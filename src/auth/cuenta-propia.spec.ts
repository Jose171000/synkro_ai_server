import { AuthController } from './auth.controller';
import { UserService } from '../users/user.service';

/**
 * Cambiar contraseña, nombre y cerrar sesión deben actuar sobre la persona que inició sesión. La estrategia JWT deja su
 * identificador en `req.user.id` (no en `sub`): usar `req.user.sub` daba `undefined`, y TypeORM, ante un id vacío, devolvía
 * el primer usuario de la tabla (la contraseña se comparaba contra la de otra persona y el cambio caía en su cuenta).
 */
describe('acciones sobre la propia cuenta', () => {
    const req = { user: { id: '26de71cc-aba3-4c7b-bebb-0827d063b764', email: 'a@b.com', role: 'admin' } };

    it('cambiar contraseña, cambiar nombre y cerrar sesión usan el id de quien inició sesión', () => {
        const authService: any = { changePassword: jest.fn(), updateProfile: jest.fn(), logout: jest.fn() };
        const controlador = new AuthController(authService, {} as any);
        controlador.changePassword(req, { currentPassword: 'x', newPassword: 'y' } as any);
        controlador.updateProfile(req, { name: 'N' } as any);
        controlador.logout(req);
        expect(authService.changePassword.mock.calls[0][0]).toBe(req.user.id);
        expect(authService.updateProfile.mock.calls[0][0]).toBe(req.user.id);
        expect(authService.logout.mock.calls[0][0]).toBe(req.user.id);
    });

    it('buscar un usuario con un id vacío nunca devuelve a otra persona ni consulta la base', async () => {
        const repo: any = { findOne: jest.fn(async () => ({ id: 'otro', name: 'Otra persona' })) };
        const servicio = new UserService(repo);
        for (const vacio of [undefined, null, '']) expect(await servicio.findById(vacio as any)).toBeNull();
        expect(repo.findOne).not.toHaveBeenCalled();
        expect(await servicio.findById('u1')).toMatchObject({ id: 'otro' });
        expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 'u1' } });
    });
});
