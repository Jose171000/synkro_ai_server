import { BulkBatchService } from './bulk-batch.service';
import { esUrlSinExtension } from './bulk-products';

const repo = (filas: any[]) => ({
    find: jest.fn(async () => filas),
    findOne: jest.fn(async () => filas[0] ?? null),
}) as any;

const hace = (minutos: number) => new Date(Date.now() - minutos * 60_000);
const lote = (over: any = {}) => ({ id: 'l1', userId: 'u1', storeId: 't1', total: 2, status: 'running', rejected: [], fileName: 'a.xlsx', createdAt: hace(1), finishedAt: null, ...over });
const item = (over: any = {}) => ({ batchId: 'l1', sku: 'A-1', status: 'pendiente', falabellaStatus: null, updatedAt: hace(1), payload: {}, ...over });

describe('cargas masivas en cola e historial', () => {
    it('los SKU y códigos de grupo pendientes de otra carga quedan ocupados, sin importar mayúsculas', async () => {
        const servicio = new BulkBatchService(repo([lote()]), repo([item(), item({ sku: 'ZAP-38', payload: { parentSku: 'ZAP' } })]));
        expect([...(await servicio.skusEnCola('u1', 't1'))].sort()).toEqual(['a-1', 'zap', 'zap-38']);
    });

    it('dice en qué va cada carga', async () => {
        const estado = async (l: any, items: any[]) => (await new BulkBatchService(repo([l]), repo(items)).historial('u1', 't1'))[0];
        expect((await estado(lote(), [item(), item({ sku: 'B' })])).estado).toBe('en_cola');
        expect((await estado(lote(), [item({ status: 'listo' }), item({ sku: 'B' })])).estado).toBe('procesando');
        expect((await estado(lote({ createdAt: hace(600) }), [item({ updatedAt: hace(500) }), item({ updatedAt: hace(500) })])).estado).toBe('detenida');
        const fin = await estado(lote({ status: 'done' }), [item({ status: 'listo', falabellaStatus: 'enviado' }), item({ status: 'fallido' })]);
        expect([fin.estado, fin.creados, fin.fallidos, fin.falabella.enviados, fin.sePuedeReintentar]).toEqual(['terminada', 1, 1, 1, true]);
    });

    it('los productos de una carga solo los ve quien la subió', async () => {
        const servicio = new BulkBatchService(repo([lote()]), repo([item({ status: 'listo', productId: 'p1' })]));
        expect(await servicio.productosDeLaCarga('l1', 'otro')).toBeNull();
        expect((await servicio.productosDeLaCarga('l1', 'u1'))![0]).toMatchObject({ sku: 'A-1', estado: 'listo', productId: 'p1' });
    });

    it('un enlace sin extensión es el que hay que abrir para saber su formato', () => {
        expect(esUrlSinExtension('https://storage.googleapis.com/bucket/52e2aec9-99b0?x=.jpg')).toBe(true);
        expect(esUrlSinExtension('https://mitienda.com/foto.jpg?v=2')).toBe(false);
        expect(esUrlSinExtension('https://mitienda.com/foto.png')).toBe(false);
        expect(esUrlSinExtension('fotos/sin-extension')).toBe(false);
    });
});
