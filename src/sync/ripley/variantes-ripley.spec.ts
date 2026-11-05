import { ChannelListingRow } from '../channels/channel-types';
import { filaDeOfertaRipley } from './ripley-mapping';
import { familiaDeProducto, planearGruposDeRipley } from './variantes-ripley';

const fila = (sku: string, title: string, groupKey: string | null = 'PMP1'): ChannelListingRow => ({
    sku, externalId: sku, variationId: null, title, variation: null, regularPrice: 10, salePrice: null, stock: 1,
    status: 'published', permalink: null, imageUrl: null, images: [], currency: 'PEN', groupKey,
});

describe('familiaDeProducto', () => {
    it('separa la base (familia) y el sufijo (variante) del código de producto de Ripley', () => {
        expect(familiaDeProducto('PMP20001695273-5')).toEqual({ base: 'PMP20001695273', variante: '5' });
        expect(familiaDeProducto('PMP20001695273-12')).toEqual({ base: 'PMP20001695273', variante: '12' });
    });
    it('sin ese formato no hay familia', () => {
        expect(familiaDeProducto('PMP20001695273')).toBeNull();
        expect(familiaDeProducto('')).toBeNull();
        expect(familiaDeProducto(undefined)).toBeNull();
    });
});

describe('la oferta lleva su familia', () => {
    const oferta = (over: any = {}) => ({ shop_sku: 'BOL0000024', offer_id: 1, product_title: 'Bolso', price: 89, quantity: 3, ...over });
    it('la base del código de producto es la familia', () => {
        expect(filaDeOfertaRipley(oferta({ product_sku: 'PMP20001695273-1' }))?.groupKey).toBe('PMP20001695273');
    });
    it('sin código de producto no hay familia', () => {
        expect(filaDeOfertaRipley(oferta())?.groupKey).toBeUndefined();
    });
});

describe('planearGruposDeRipley', () => {
    it('agrupa las ofertas de un mismo producto y saca el color de las palabras del título que cambian', () => {
        const { grupos, sinResolver } = planearGruposDeRipley([
            fila('LCH-1', 'LONCHERA ROSADA TÉRMICA PARA ALIMENTOS'),
            fila('LCH-2', 'LONCHERA NEGRO TÉRMICA PARA ALIMENTOS'),
            fila('LCH-3', 'LONCHERA AZUL TÉRMICA PARA ALIMENTOS'),
        ]);
        expect(sinResolver).toEqual([]);
        expect(grupos).toHaveLength(1);
        expect(grupos[0]).toMatchObject({ parentSku: 'PMP1', name: 'LONCHERA TÉRMICA PARA ALIMENTOS', origen: 'titulo' });
        expect(grupos[0].axes).toEqual([{ name: 'Color', values: ['Rosada', 'Negro', 'Azul'] }]);
        expect(grupos[0].variants).toEqual([
            { sellerSku: 'LCH-1', values: { Color: 'Rosada' } },
            { sellerSku: 'LCH-2', values: { Color: 'Negro' } },
            { sellerSku: 'LCH-3', values: { Color: 'Azul' } },
        ]);
    });

    it('el color puede ir al final, tras un guion', () => {
        const { grupos } = planearGruposDeRipley([
            fila('E-1', 'ETIQUETAS PARA MALETAS DE VIAJE - CELESTE'),
            fila('E-2', 'ETIQUETAS PARA MALETAS DE VIAJE - BLANCO'),
        ]);
        expect(grupos[0].name).toBe('ETIQUETAS PARA MALETAS DE VIAJE');
        expect(grupos[0].axes[0].values).toEqual(['Celeste', 'Blanco']);
    });

    it('si los títulos son iguales no se adivina: queda para estructurarla a mano, con sus fichas', () => {
        const { grupos, sinResolver } = planearGruposDeRipley([
            fila('M-1', 'MORRAL DESSY EN TELA POLIESTER PARA DAMA'),
            fila('M-2', 'MORRAL DESSY EN TELA POLIESTER PARA DAMA'),
        ]);
        expect(grupos).toEqual([]);
        expect(sinResolver).toHaveLength(1);
        expect(sinResolver[0]).toMatchObject({ parentSku: 'PMP1', skus: ['M-1', 'M-2'], titulo: 'MORRAL DESSY EN TELA POLIESTER PARA DAMA' });
        expect(sinResolver[0].fichas).toEqual([
            { sku: 'M-1', nombre: 'MORRAL DESSY EN TELA POLIESTER PARA DAMA', imagen: null },
            { sku: 'M-2', nombre: 'MORRAL DESSY EN TELA POLIESTER PARA DAMA', imagen: null },
        ]);
    });

    it('si una oferta no deja ningún valor propio o dos repiten el mismo, la familia no se arma sola', () => {
        expect(planearGruposDeRipley([fila('A', 'BOLSO NEGRO'), fila('B', 'BOLSO NEGRO GRANDE')]).sinResolver).toHaveLength(1);
        const repetidos = planearGruposDeRipley([fila('A', 'BOLSO ROJO'), fila('B', 'bolso rojo'), fila('C', 'BOLSO AZUL')]);
        expect(repetidos.grupos).toHaveLength(0);
        expect(repetidos.sinResolver).toHaveLength(1);
    });

    it('una oferta sola o sin familia queda como producto suelto', () => {
        const r = planearGruposDeRipley([fila('SOLA', 'BOLSO', 'PMP9'), fila('SUELTA', 'BOLSO', null)]);
        expect(r.grupos).toEqual([]);
        expect(r.sinResolver).toEqual([]);
    });

    it('familias distintas no se mezclan y un SKU repetido cuenta una vez', () => {
        const r = planearGruposDeRipley([
            fila('A1', 'MOCHILA ROJA', 'F1'), fila('A2', 'MOCHILA VERDE', 'F1'), fila('A2', 'MOCHILA VERDE', 'F1'),
            fila('B1', 'MALETA ROSA', 'F2'), fila('B2', 'MALETA NEGRA', 'F2'),
        ]);
        expect(r.grupos.map((g) => [g.parentSku, g.variants.length])).toEqual([['F1', 2], ['F2', 2]]);
    });
});
