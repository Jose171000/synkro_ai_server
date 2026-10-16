import { FalabellaApiService } from './falabella-api.service';

describe('motivos del control de calidad de Falabella', () => {
    const creds = { userId: 'u', apiKey: 'k' };

    it('lee la respuesta real de GetQcStatus: Status.State con SellerSKU y Reason, y un SKU puede repetirse', async () => {
        const api = new FalabellaApiService();
        (api as any).call = jest.fn(async () => ({
            Status: {
                State: [
                    { SellerSKU: 'MK-MES-001', Status: 'rejected', Reason: 'Equipo Contenido -  Producto no autorizado' },
                    { SellerSKU: 'MK-TOR-004', Status: 'rejected', Reason: '"DI.4 Se debe ampliar la descripción"  \\"DI.3 El nombre no cumple\\"' },
                    { SellerSKU: 'MK-TOR-004', Status: 'rejected', Reason: 'otro motivo repetido' },
                    { SellerSKU: 'MK-OK-1', Status: 'approved', Reason: '' },
                ],
            },
        }));

        const m = await api.getQcStatus(creds, ['MK-MES-001', 'MK-TOR-004', 'MK-OK-1']);

        expect(m.get('MK-MES-001')).toBe('Equipo Contenido - Producto no autorizado');
        expect(m.get('MK-TOR-004')).toContain('DI.4 Se debe ampliar la descripción');
        expect(m.get('MK-TOR-004')).not.toContain('otro motivo');
        expect(m.get('MK-TOR-004')).not.toContain('\\');
        expect(m.has('MK-OK-1')).toBe(false);
    });

    it('sin SKUs no llama a Falabella', async () => {
        const api = new FalabellaApiService();
        (api as any).call = jest.fn();
        expect((await api.getQcStatus(creds, [])).size).toBe(0);
        expect((api as any).call).not.toHaveBeenCalled();
    });
});
