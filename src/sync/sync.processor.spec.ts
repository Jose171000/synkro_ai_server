import { SyncProcessor } from './sync.processor';

/** El historial de Revisión nunca debe decir «Enviado» si el canal no recibió el cambio. */
describe('SyncProcessor: cierre de solicitudes de cambio', () => {
    const armar = (resultadoDelCanal: any) => {
        const syncService: any = { hasChannel: jest.fn(() => true), pushInventoryToChannel: jest.fn(async () => resultadoDelCanal) };
        const changeRequests: any = { markResult: jest.fn(async () => undefined), markSkipped: jest.fn(async () => undefined) };
        const procesador = new SyncProcessor(syncService, changeRequests, {} as any, {} as any);
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

describe('SyncProcessor: publicar en Ripley desde la cola estándar', () => {
    const armar = (publicar: jest.Mock) => {
        const syncService: any = { avisarEnvioARipley: jest.fn(async () => undefined) };
        const ripley: any = { publicar };
        const procesador = new SyncProcessor(syncService, {} as any, {} as any, {} as any, ripley);
        const trabajo: any = { id: 'j1', name: 'publish', data: { productId: 'p1', userId: 'u1', storeId: 's1', marketplace: 'ripley', connectionId: 'c1', alGrupo: true } };
        return { procesador, syncService, ripley, trabajo };
    };
    beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
    afterEach(() => jest.restoreAllMocks());

    it('envía el grupo con la confirmación de quien pulsó Publicar y avisa del resultado', async () => {
        const { procesador, syncService, ripley, trabajo } = armar(jest.fn(async () => ({ importId: '77', enviados: ['A-1', 'A-2'] })));
        const r = await procesador.process(trabajo);
        expect(ripley.publicar).toHaveBeenCalledWith({ userId: 'u1', storeId: 's1' }, 'p1', { alGrupo: true, confirmar: true, connectionId: 'c1' });
        expect(r).toEqual({ status: 'enviado', importId: '77', enviados: ['A-1', 'A-2'] });
        expect(syncService.avisarEnvioARipley).toHaveBeenCalledWith('u1', 'p1', expect.objectContaining({ ok: true }));
    });

    it('si Ripley rechaza (interruptor apagado, datos por corregir…) avisa con el motivo y no reintenta', async () => {
        const { procesador, syncService, trabajo } = armar(jest.fn(async () => { throw new Error('La publicación en Ripley está apagada en el servidor.'); }));
        await expect(procesador.process(trabajo)).rejects.toThrow(/apagada/);
        expect(syncService.avisarEnvioARipley).toHaveBeenCalledWith('u1', 'p1', { ok: false, texto: expect.stringMatching(/apagada/) });
    });
});
