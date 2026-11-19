import { BadRequestException, ConflictException } from '@nestjs/common';
import { ProductGroupsService } from './product-groups.service';

const ambito = { userId: 'u1', storeId: 't1' };

function armar(opciones: { canales?: string[]; ocupados?: string[]; siguiente?: string } = {}) {
    const svc: any = Object.create(ProductGroupsService.prototype);
    const ocupados = new Set((opciones.ocupados ?? []).map((s) => s.toLowerCase()));
    svc.obtener = jest.fn(async () => ({ id: 'g1', parentSku: '23090103', variants: [{}, {}] }));
    svc.skuGenerator = { siguientes: jest.fn(async () => [opciones.siguiente ?? '23090104']) };
    svc.products = { skusExistentes: jest.fn(async (_a: any, skus: string[]) => new Set(skus.map((s) => s.toLowerCase()).filter((s) => ocupados.has(s)))) };
    const manager = { update: jest.fn(async () => undefined), query: jest.fn(async () => undefined) };
    svc.dataSource = {
        query: jest.fn(async () => (opciones.canales ?? ['ripley']).map((marketplace) => ({ marketplace }))),
        transaction: jest.fn(async (fn: any) => fn(manager)),
    };
    return { svc, manager };
}

describe('cambiar el código de un grupo de variantes', () => {
    it('sin indicar código usa el siguiente libre y actualiza el grupo y sus enlaces', async () => {
        const { svc, manager } = armar();
        expect(await svc.cambiarCodigo('g1', undefined, ambito)).toEqual({ anterior: '23090103', nuevo: '23090104', variantes: 2, canales: ['ripley'] });
        expect(manager.update).toHaveBeenCalledWith(expect.anything(), 'g1', { parentSku: '23090104' });
        expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE listing_links'), ['g1', '23090104', '23090103']);
    });

    it('un código escrito que ya es SKU de un producto o de otro grupo se rechaza', async () => {
        const { svc, manager } = armar({ ocupados: ['abc'] });
        await expect(svc.cambiarCodigo('g1', 'ABC', ambito)).rejects.toBeInstanceOf(ConflictException);
        expect(manager.update).not.toHaveBeenCalled();
    });

    it('el mismo código no es un cambio', async () => {
        const { svc } = armar();
        await expect(svc.cambiarCodigo('g1', ' 23090103 ', ambito)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('si el grupo ya está en Falabella no se cambia', async () => {
        const { svc, manager } = armar({ canales: ['ripley', 'falabella'] });
        await expect(svc.cambiarCodigo('g1', undefined, ambito)).rejects.toThrow(/Falabella/);
        expect(manager.update).not.toHaveBeenCalled();
    });
});
