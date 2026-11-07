import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BulkUploadController } from './bulk-upload.controller';

function construir(paraReintentar: any) {
    const cola: any = { add: jest.fn(async () => undefined) };
    const bulkBatch: any = {
        paraReintentar: jest.fn(async () => paraReintentar),
        crear: jest.fn(async () => undefined),
        marcarReintentados: jest.fn(async () => undefined),
    };
    const lote: any = { iniciar: jest.fn(async () => undefined) };
    const controller = new BulkUploadController(cola, cola, cola, cola, {} as any, {} as any, {} as any, {} as any, {} as any, lote, bulkBatch, {} as any);
    return { controller, cola, bulkBatch, lote };
}

const req = { user: { id: 'u1' } };
const base = { storeId: 's1', puedeReintentarse: true, fallidos: [], falabellaPendientes: [], payloadBase: { cuentas: { falabella: ['c1'] } } };

describe('reintentar una carga masiva', () => {
    it('una carga que no existe o es de otro usuario da 404', async () => {
        await expect(construir(null).controller.reintentarCarga('b1', req)).rejects.toThrow(NotFoundException);
    });

    it('una carga todavía en proceso no se reintenta', async () => {
        await expect(construir({ ...base, puedeReintentarse: false, fallidos: [{ sku: 'A', payload: {} }] }).controller.reintentarCarga('b1', req)).rejects.toThrow(BadRequestException);
    });

    it('sin fallidos ni pendientes no hay nada que reintentar', async () => {
        await expect(construir(base).controller.reintentarCarga('b1', req)).rejects.toThrow(BadRequestException);
    });

    it('los fallidos salen en un lote nuevo con sus datos originales, marcados como reintento', async () => {
        const { controller, cola, bulkBatch, lote } = construir({ ...base, fallidos: [{ sku: 'A', payload: { sku: 'A', price: 10, batchId: 'b1', batchTotal: 9 } }, { sku: 'B', payload: { sku: 'B', price: 20 } }] });
        const r = await controller.reintentarCarga('b1', req);
        expect(r.reintentados).toBe(2);
        expect(r.batchId).toBeDefined();
        expect(r.batchId).not.toBe('b1');
        expect(lote.iniciar).toHaveBeenCalledWith(r.batchId, 2, 'u1');
        const [nombre, datos] = cola.add.mock.calls[0];
        expect(nombre).toBe('process-product');
        expect(datos).toMatchObject({ sku: 'A', price: 10, batchId: r.batchId, batchTotal: 2, reintento: true });
        expect(bulkBatch.marcarReintentados).toHaveBeenCalledWith('b1', ['A', 'B']);
    });

    it('los que quedaron sin enviar a Falabella se reenvían en un trabajo aparte', async () => {
        const { controller, cola } = construir({ ...base, falabellaPendientes: ['p1', 'p2'] });
        const r = await controller.reintentarCarga('b1', req);
        expect(r.batchId).toBeUndefined();
        expect(r.falabellaReenviados).toBe(2);
        expect(cola.add).toHaveBeenCalledWith('enviar-falabella', expect.objectContaining({ batchId: 'b1', userId: 'u1', storeId: 's1', productIds: ['p1', 'p2'] }), expect.anything());
    });
});
