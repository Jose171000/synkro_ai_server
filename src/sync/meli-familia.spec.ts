import { SyncService } from './sync.service';

/** Las variantes de un grupo salen en Mercado Libre como una familia: mismo nombre sin color, y el color de cada una. */
const proto: any = SyncService.prototype;
const contexto = { atributosParaMeli: proto.atributosParaMeli };
const payloadDe = (p: any) => proto.buildMeliItemPayload.call(contexto, p, 'MPE1');
const idsDe = (p: any) => Object.fromEntries(contexto.atributosParaMeli(p).map((a: any) => [a.id, a.value_name]));

const grupo = { name: 'Perchero Elegante Multifuncional Kasari Metal Negro Azul', parentSku: 'PERCHERO-METAL', axes: [{ name: 'Color', values: ['Negro', 'Celeste'] }] };
const variante = (sku: string, color: string) => ({
    sku, name: `Perchero Elegante Multifuncional Kasari Metal Negro Azul - ${color}`, aiTitle: `Perchero Elegante Multifuncional Kasari Metal - ${color}`, price: 39.9, stock: 10, images: [{ url: 'https://i/1.jpg' }],
    group: grupo, variantValues: { Color: color },
    aiAttributes: { brand: 'Kasari', mercadolibre_attributes: { COLOR: 'Azul', MAIN_COLOR: 'Negro', MATERIAL: 'Metal' } },
});

describe('familias de Mercado Libre', () => {
    it('todas las variantes llevan el mismo family_name, sin colores', () => {
        const a = payloadDe(variante('OG144', 'Negro'));
        const b = payloadDe(variante('OG146', 'Celeste'));
        expect(a.family_name).toBe('Perchero Elegante Multifuncional Kasari Metal');
        expect(b.family_name).toBe(a.family_name);
    });

    it('cada variante lleva su propio color, su SKU y el modelo del grupo', () => {
        const negro = idsDe(variante('OG144', 'Negro'));
        const celeste = idsDe(variante('OG146', 'Celeste'));
        expect(negro).toMatchObject({ COLOR: 'Negro', MAIN_COLOR: 'Negro', SELLER_SKU: 'OG144', MODEL: 'PERCHERO-METAL', MATERIAL: 'Metal' });
        expect(celeste).toMatchObject({ COLOR: 'Celeste', MAIN_COLOR: 'Celeste', SELLER_SKU: 'OG146', MODEL: 'PERCHERO-METAL' });
    });

    it('un producto sin grupo se publica como siempre', () => {
        const simple = { sku: 'KI-1', name: 'Taza', aiTitle: 'Taza de cerámica azul', price: 10, stock: 3, images: [], group: null, variantValues: null, aiAttributes: { brand: 'X', mercadolibre_attributes: { COLOR: 'Azul' } } };
        expect(payloadDe(simple).family_name).toBe('Taza de cerámica azul');
        expect(idsDe(simple)).toMatchObject({ COLOR: 'Azul', MODEL: 'KI-1', SELLER_SKU: 'KI-1' });
    });
});

describe('nombre de una variante en Falabella cuando sale como ficha suelta', () => {
    const servicio: any = Object.create(SyncService.prototype);
    const ficha = (sku: string, color: string, extra: any = {}) => ({
        sku, name: `Perchero Elegante Multifuncional Kasari Metal Negro Azul - ${color}`, aiTitle: `Perchero Elegante Multifuncional Kasari Metal Negr - ${color}`,
        price: 39.9, stock: 5, images: [{ url: 'https://i/1.jpg' }], description: 'Un perchero metálico moderno',
        packageWidth: 18, packageLength: 80, packageHeight: 12, packageWeight: 2.2,
        marketplaceIds: { falabella_category_id: '3169' },
        aiAttributes: { brand: 'Kasari', color: 'Azul', color_basico: 'Negro' },
        group: grupo, variantValues: { Color: color }, ...extra,
    });

    it('se arma desde el nombre del grupo con el color al final, sin palabras partidas ni colores repetidos', () => {
        const negro = servicio.toFalabellaInput(ficha('OG144', 'Negro'));
        const celeste = servicio.toFalabellaInput(ficha('OG146', 'Celeste'));
        expect(negro.input.name).toBe('Perchero Elegante Multifuncional Kasari Metal - Negro');
        expect(celeste.input.name).toBe('Perchero Elegante Multifuncional Kasari Metal - Celeste');
    });

    it('un producto sin grupo conserva su título', () => {
        const simple = servicio.toFalabellaInput(ficha('KI-1', 'x', { group: null, variantValues: null, aiTitle: 'Taza de cerámica azul 350 ml', name: 'Taza' }));
        expect(simple.input.name).toBe('Taza de cerámica azul 350 ml');
    });
});

describe('publicar un grupo de variantes sin IA', () => {
    const construir = (familia: any[], enqueue: jest.Mock) => {
        const s: any = Object.create(SyncService.prototype);
        s.familiaDe = jest.fn(async () => familia);
        s.enqueuePublish = enqueue;
        return s as SyncService;
    };
    const scope: any = { userId: 'u', storeId: 's' };

    it('manda la orden de cada variante y no falla si algunas ya estaban publicadas', async () => {
        const enqueue = jest.fn(async (_s: any, id: string) => { if (id === 'b') throw new Error('Este producto ya está publicado'); return { message: 'ok' }; });
        const r = await construir([{ id: 'a' }, { id: 'b' }, { id: 'c' }], enqueue).enqueuePublishFamilia(scope, 'a', ['mercadolibre'], { mercadolibre: 'c1' });
        expect(enqueue).toHaveBeenCalledTimes(3);
        expect(r.message).toContain('2 de 3 variantes');
    });

    it('si ninguna se pudo encolar, devuelve el error', async () => {
        const enqueue = jest.fn(async () => { throw new Error('Este producto ya está publicado'); });
        await expect(construir([{ id: 'a' }, { id: 'b' }], enqueue).enqueuePublishFamilia(scope, 'a', ['mercadolibre'])).rejects.toThrow(/ya está publicado/);
    });

    it('un producto sin variantes se publica como siempre', async () => {
        const enqueue = jest.fn(async () => ({ message: 'ok' }));
        await construir([{ id: 'a' }], enqueue).enqueuePublishFamilia(scope, 'a', ['falabella']);
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(enqueue).toHaveBeenCalledWith(scope, 'a', ['falabella'], {});
    });
});
