import { ChangeRequestsService } from './change-requests.service';

const SCOPE = { userId: 'u1', storeId: 't1' };
const producto = { id: 'p1', sku: 'S1', stock: 3, price: 50 };
const solicitud = (over: any = {}) => ({
    id: 'e1', status: 'error', field: 'stock', marketplace: 'woocommerce', previousValue: '15', newValue: '8',
    createdAt: new Date('2026-11-23T10:00:00Z'), product: producto, connection: { id: 'c1' }, ...over,
});

function construir(errores: any[], todas: any[] = errores, revision = false) {
    const qb: any = {};
    for (const m of ['leftJoinAndSelect', 'where', 'andWhere', 'orderBy', 'take']) qb[m] = jest.fn(() => qb);
    qb.getMany = jest.fn(async () => errores);
    const repo: any = { createQueryBuilder: () => qb, find: jest.fn(async () => todas), update: jest.fn(), create: (e: any) => e, save: jest.fn(async (e: any) => ({ id: 'nueva', ...e })) };
    const tiendas: any = { findOne: jest.fn(async () => ({ syncReviewMode: revision })) };
    const service = new ChangeRequestsService(repo, {} as any, tiendas, {} as any, { findOne: jest.fn(async () => null) } as any);
    const aprobar = jest.spyOn(service, 'approve').mockResolvedValue({} as any);
    return { service, repo, aprobar };
}

describe('reenviar los envíos con error', () => {
    it('manda el valor de ahora (no el antiguo), una sola vez por producto, cuenta y campo', async () => {
        const { service, repo, aprobar } = construir([solicitud(), solicitud({ id: 'e0', createdAt: new Date('2026-11-22T10:00:00Z') })]);
        const r = await service.reenviarErrores(SCOPE);
        expect(r.reenviadas).toBe(1);
        expect(repo.save).toHaveBeenCalledTimes(1);
        expect(repo.save.mock.calls[0][0]).toMatchObject({ newValue: '3', status: 'pending' });
        expect(aprobar).toHaveBeenCalledWith('nueva', SCOPE);
    });

    it('con el modo revisión quedan pendientes de aprobar', async () => {
        const { service, aprobar } = construir([solicitud()], [solicitud()], true);
        expect(await service.reenviarErrores(SCOPE)).toMatchObject({ reenviadas: 1, enRevision: true });
        expect(aprobar).not.toHaveBeenCalled();
    });

    it('no repite lo que ya salió después, ni inventa un descuento que ya no existe', async () => {
        const error = solicitud();
        const enviada = solicitud({ id: 's1', status: 'sent', createdAt: new Date('2026-11-24T10:00:00Z') });
        const uno = construir([error], [enviada, error]);
        expect(await uno.service.reenviarErrores(SCOPE)).toMatchObject({ reenviadas: 0, omitidas: [{ sku: 'S1', motivo: 'Ya se envió después.' }] });

        const promo = solicitud({ field: 'promo', newValue: '40|2026-11-01|2026-12-01' });
        const dos = construir([promo]);
        expect((await dos.service.reenviarErrores(SCOPE)).reenviadas).toBe(0);
        expect(dos.repo.save).not.toHaveBeenCalled();
    });
});
