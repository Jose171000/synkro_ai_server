import { SaleAlertsService } from './sale-alerts.service';

const usuario = (email: string, extra: any = {}) => ({ id: email, email, name: email.split('@')[0], isActive: true, approvalStatus: 'approved', ...extra });

function construir(opts: { miembros?: any[]; dueno?: any; ownerDeVenta?: any }) {
    const members: any = { find: jest.fn(async () => (opts.miembros ?? []).map((user) => ({ user }))) };
    const stores: any = { findOne: jest.fn(async () => ({ id: 's1', name: 'Laihome', owner: opts.dueno ?? null })) };
    const users: any = { findOne: jest.fn(async () => opts.ownerDeVenta ?? null) };
    const mail: any = { sendSaleAlert: jest.fn(async () => undefined) };
    return { service: new SaleAlertsService(members, stores, users, mail), mail };
}

const venta: any = {
    store: { id: 's1' }, owner: { id: 'u1' }, externalId: '9', orderNumber: '9', customerName: 'Ana', currency: 'PEN',
    totalAmount: 120, itemsCount: 2, items: [{ title: 'Silla', sku: 'S-1', quantity: 2, unitPrice: 60 }], shipByDate: null,
};

describe('avisos de venta por correo', () => {
    it('avisa al dueño y a todo el equipo, sin repetir correos', async () => {
        const { service, mail } = construir({
            dueno: usuario('dueno@x.com'),
            miembros: [usuario('dueno@x.com'), usuario('Editor@x.com'), usuario('lector@x.com')],
        });
        await service.notificar(venta, 'Mercado Libre');
        const enviados = mail.sendSaleAlert.mock.calls.map((c: any[]) => c[0].toLowerCase()).sort();
        expect(enviados).toEqual(['dueno@x.com', 'editor@x.com', 'lector@x.com']);
        expect(mail.sendSaleAlert.mock.calls[0][1]).toMatchObject({ storeName: 'Laihome', channel: 'Mercado Libre', total: '120.00', currency: 'PEN' });
    });

    it('no escribe a cuentas desactivadas ni rechazadas', async () => {
        const { service, mail } = construir({
            dueno: usuario('dueno@x.com'),
            miembros: [usuario('baja@x.com', { isActive: false }), usuario('no@x.com', { approvalStatus: 'rejected' })],
        });
        await service.notificar(venta, 'Falabella');
        expect(mail.sendSaleAlert.mock.calls.map((c: any[]) => c[0])).toEqual(['dueno@x.com']);
    });

    it('una venta sin tienda avisa a quien la conectó', async () => {
        const { service, mail } = construir({ ownerDeVenta: usuario('yo@x.com') });
        await service.notificar({ ...venta, store: null }, 'Shopify');
        expect(mail.sendSaleAlert.mock.calls.map((c: any[]) => c[0])).toEqual(['yo@x.com']);
    });

    it('un fallo del correo no se propaga', async () => {
        const { service, mail } = construir({ dueno: usuario('dueno@x.com') });
        mail.sendSaleAlert.mockRejectedValue(new Error('brevo caído'));
        await expect(service.notificar(venta, 'WooCommerce')).resolves.toBeUndefined();
    });
});
