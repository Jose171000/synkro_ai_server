import { BadRequestException } from '@nestjs/common';
import { SyncService } from './sync.service';

/**
 * Falabella trata a las variantes con el mismo código padre como una familia: enviadas de a una, el último envío pisa el tamaño de las demás.
 * Por eso el contenido de una variante se manda junto con el de TODAS sus hermanas publicadas, cada una con su propio valor.
 */
const SCOPE = { userId: 'u', storeId: 's' };

function construir(opts: { familia: any[]; enlaces: Record<string, any>; razon?: Record<string, string> }) {
    const s: any = Object.create(SyncService.prototype);
    const porId = new Map(opts.familia.map((p) => [p.id, p]));
    s.findScopedProduct = jest.fn(async (_: any, id: string) => porId.get(id));
    s.familiaDe = jest.fn(async () => opts.familia);
    s.resolveConnection = jest.fn(async () => ({ id: 'c1' }));
    s.credentialsOf = jest.fn(() => ({ userId: 'x' }));
    s.categoriaFalabella = jest.fn(() => '3137');
    s.toFalabellaInput = jest.fn((p: any) => (opts.razon?.[p.id] ? { reason: opts.razon[p.id] } : { input: { sellerSku: p.sku, name: 'Duvet', tamano: p.variantValues['Tamaño cama'] } }));
    s.falabellaApi = { getCategoryAttributes: jest.fn(async () => []), updateProductContent: jest.fn(async () => 'feed-1') };
    s.listingLinkRepository = { findOne: jest.fn(async ({ where }: any) => opts.enlaces[where.product.id] ?? null) };
    s.feedRepository = { create: jest.fn((x: any) => x), save: jest.fn(async (x: any) => ({ ...x, id: 'r1' })) };
    s.syncQueue = { add: jest.fn(async () => undefined) };
    return s;
}

const duvet = (id: string, sku: string, tam: string) => ({ id, sku, variantValues: { 'Tamaño cama': tam } });
const F = duvet('a', 'UVT-F', '2 plazas');
const K = duvet('b', 'UVT-K', 'King');
const publicado = { syncStatus: 'published' };

describe('actualizar el contenido de una variante en Falabella', () => {
    it('manda a la vez TODAS las fichas publicadas de la familia, cada una con su tamaño, en un solo envío', async () => {
        const s = construir({ familia: [F, K], enlaces: { a: publicado, b: publicado } });
        const r = await s.updateFalabellaContent(SCOPE, 'b');
        expect(s.falabellaApi.updateProductContent).toHaveBeenCalledTimes(1);
        const enviados = s.falabellaApi.updateProductContent.mock.calls[0][1];
        expect(enviados.map((e: any) => [e.sellerSku, e.tamano])).toEqual([['UVT-F', '2 plazas'], ['UVT-K', 'King']]);
        expect(r.skus).toEqual(['UVT-F', 'UVT-K']);
        expect(r.message).toContain('2 fichas de la familia a la vez');
        expect(s.feedRepository.save.mock.calls[0][0]).toMatchObject({ skus: ['UVT-F', 'UVT-K'], totalRecords: 2 });
    });

    it('una hermana que no está publicada en esa cuenta no se manda', async () => {
        const s = construir({ familia: [F, K], enlaces: { b: publicado } });
        const r = await s.updateFalabellaContent(SCOPE, 'b');
        expect(r.skus).toEqual(['UVT-K']);
    });

    it('una hermana incompleta no frena a las demás, pero si la pedida está incompleta, se avisa', async () => {
        const s = construir({ familia: [F, K], enlaces: { a: publicado, b: publicado }, razon: { a: 'le faltan medidas' } });
        expect((await s.updateFalabellaContent(SCOPE, 'b')).skus).toEqual(['UVT-K']);
        const s2 = construir({ familia: [F, K], enlaces: { a: publicado, b: publicado }, razon: { b: 'le faltan medidas' } });
        await expect(s2.updateFalabellaContent(SCOPE, 'b')).rejects.toThrow(BadRequestException);
        expect(s2.falabellaApi.updateProductContent).not.toHaveBeenCalled();
    });

    it('un producto sin variantes se actualiza como siempre, solo él', async () => {
        const solo = duvet('z', 'SOLO-1', '-');
        const s = construir({ familia: [solo], enlaces: { z: publicado } });
        const r = await s.updateFalabellaContent(SCOPE, 'z');
        expect(r.skus).toEqual(['SOLO-1']);
        expect(r.message).toBe('Actualización enviada a Falabella. Se procesa en segundo plano y la calidad de la ficha puede tardar en reflejarse.');
    });
});
