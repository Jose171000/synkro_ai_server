import { SyncProcessor } from './sync.processor';

/** El historial de Revisión nunca debe decir «Enviado» si el canal no recibió el cambio. */
describe('SyncProcessor: cierre de solicitudes de cambio', () => {
    const armar = (resultadoDelCanal: any) => {
        const syncService: any = { hasChannel: jest.fn(() => true), pushInventoryToChannel: jest.fn(async () => resultadoDelCanal) };
        const changeRequests: any = { markResult: jest.fn(async () => undefined), markSkipped: jest.fn(async () => undefined) };
        const procesador = new SyncProcessor(syncService, changeRequests, {} as any);
        const trabajo: any = { id: 'j1', name: 'inventory', data: { productId: 'p1', marketplace: 'ripley', connectionId: 'c1', changeRequestId: 'r1' } };
        return { procesador, changeRequests, trabajo };
    };
    beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
    afterEach(() => jest.restoreAllMocks());

    it('si el canal envió, la solicitud queda como enviada', async () => {
        const { procesador, changeRequests, trabajo } = armar(undefined);
        const r = await procesador.process(trabajo);
        expect(r).toEqual({ status: 'synced' });
        expect(changeRequests.markResult).toHaveBeenCalledWith('r1', true);
        expect(changeRequests.markSkipped).not.toHaveBeenCalled();
    });

    it('si el canal omitió el envío a propósito, queda como «no enviado» con el motivo y no como enviada', async () => {
        const { procesador, changeRequests, trabajo } = armar({ omitido: 'El envío de stock a Ripley está apagado.' });
        const r = await procesador.process(trabajo);
        expect(r).toEqual({ status: 'omitido', message: 'El envío de stock a Ripley está apagado.' });
        expect(changeRequests.markSkipped).toHaveBeenCalledWith('r1', 'El envío de stock a Ripley está apagado.');
        expect(changeRequests.markResult).not.toHaveBeenCalled();
    });
});
