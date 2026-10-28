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
