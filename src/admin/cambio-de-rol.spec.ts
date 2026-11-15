import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';

/**
 * Cambiar el rol da o quita el poder de ver y borrar a todos los clientes: los frenos importan tanto como el cambio.
 */
function armar(usuarios: any[]) {
    const guardados: any[] = [];
    const borrados: any[] = [];
    const userRepository: any = {
        findOne: jest.fn(async ({ where }: any) => usuarios.find(u => u.id === where.id) ?? null),
        count: jest.fn(async ({ where }: any) => usuarios.filter(u => u.role === where.role && u.isActive === where.isActive).length),
        save: jest.fn(async (u: any) => { guardados.push({ ...u }); return u; }),
    };
    const dataSource: any = { getRepository: () => ({ delete: jest.fn(async (c: any) => { borrados.push(c); }) }) };
    const svc = new AdminService(userRepository, null as any, null as any, null as any, null as any, null as any, dataSource, null as any);
    return { svc, guardados, borrados };
}

const admin = (id: string, email = `${id}@x.com`) => ({ id, email, role: 'admin', isActive: true });
const cliente = (id: string, email = `${id}@x.com`) => ({ id, email, role: 'user', isActive: true });

describe('cambio de rol', () => {
    const anterior = process.env.ADMIN_EMAILS;
    afterEach(() => { process.env.ADMIN_EMAILS = anterior; if (anterior === undefined) delete process.env.ADMIN_EMAILS; });

    it('baja a un superadmin a cliente y cierra sus sesiones', async () => {
        const { svc, guardados, borrados } = armar([admin('yo'), admin('jasmin')]);
        const r = await svc.updateRole('jasmin', 'user', 'yo');
        expect(guardados[0]).toMatchObject({ id: 'jasmin', role: 'user' });
        expect(borrados).toEqual([{ user: { id: 'jasmin' } }]);
        expect(r.message).toMatch(/cambiado a user/);
    });

    it('asciende a un cliente a superadmin', async () => {
        const { svc, guardados } = armar([admin('yo'), cliente('ana')]);
        await svc.updateRole('ana', 'admin', 'yo');
        expect(guardados[0]).toMatchObject({ id: 'ana', role: 'admin' });
    });

    it('no deja cambiarse el rol a uno mismo', async () => {
        const { svc, guardados } = armar([admin('yo'), admin('otro')]);
        await expect(svc.updateRole('yo', 'user', 'yo')).rejects.toBeInstanceOf(BadRequestException);
        expect(guardados).toHaveLength(0);
    });

    it('no deja al sistema sin superadmin', async () => {
        const { svc, guardados } = armar([admin('otro'), { ...admin('yo'), isActive: false }]);
        await expect(svc.updateRole('otro', 'user', 'yo')).rejects.toThrow(/único superadmin/);
        expect(guardados).toHaveLength(0);
    });

    it('no baja a quien está en ADMIN_EMAILS (se ascendería de nuevo al arrancar)', async () => {
        process.env.ADMIN_EMAILS = 'Jasmin@X.com, otro@y.com';
        const { svc, guardados } = armar([admin('yo'), admin('jasmin', 'jasmin@x.com')]);
        await expect(svc.updateRole('jasmin', 'user', 'yo')).rejects.toThrow(/ADMIN_EMAILS/);
        expect(guardados).toHaveLength(0);
    });

    it('con el mismo rol no hace nada ni cierra sesiones', async () => {
        const { svc, guardados, borrados } = armar([admin('yo'), cliente('ana')]);
        const r = await svc.updateRole('ana', 'user', 'yo');
        expect(r.message).toMatch(/ya tiene ese rol/);
        expect(guardados).toHaveLength(0);
        expect(borrados).toHaveLength(0);
    });

    it('una cuenta que no existe da 404', async () => {
        const { svc } = armar([admin('yo')]);
        await expect(svc.updateRole('nadie', 'user', 'yo')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('contador es un rol válido', async () => {
        const { svc, guardados } = armar([admin('yo'), cliente('ana')]);
        await svc.updateRole('ana', 'contador', 'yo');
        expect(guardados[0].role).toBe('contador');
    });
});
