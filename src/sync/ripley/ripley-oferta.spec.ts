import axios from 'axios';
import { armarOfertaParaEnviar, motivoParaNoTocarOferta, resumenDeCambios, skuPermitidoParaRipley } from './ripley-oferta';
import { RipleyApiService } from './ripley-api.service';

const ofertaActual = () => ({
    offer_id: 777,
    shop_sku: '23090102',
    product_sku: 'PMP20001695273-5',
    product_title: 'Bolso negro',
    price: 89.9,
    quantity: 5,
    state_code: '11',
    active: true,
    description: 'Bolso de cuero',
    internal_description: 'nota interna',
    leadtime_to_ship: 3,
    min_quantity_alert: 1,
    logistic_class: { code: 'L1', label: 'Liviano' },
    available_start_date: '2026-01-01T00:00:00Z',
    discount: { discount_price: 79.9, start_date: '2026-11-01T00:00:00Z', end_date: '2026-12-01T00:00:00Z', origin_price: 89.9 },
    allow_quote_requests: false,
    all_prices: [{ channel_code: null, unit_origin_price: 89.9 }],
});

describe('armarOfertaParaEnviar', () => {
    it('manda la oferta COMPLETA: solo cambia el stock y conserva todo lo demás con los nombres de escritura', () => {
        const o = armarOfertaParaEnviar(ofertaActual(), { stock: 4 });
        expect(o).toMatchObject({
            shop_sku: '23090102', update_delete: 'update', state_code: '11', price: 89.9, quantity: 4,
            description: 'Bolso de cuero', internal_description: 'nota interna', leadtime_to_ship: 3, min_quantity_alert: 1,
            logistic_class: 'L1', available_started: '2026-01-01T00:00:00Z', allow_quote_requests: false,
            discount: { price: 79.9, start_date: '2026-11-01T00:00:00Z', end_date: '2026-12-01T00:00:00Z' },
        });
        // No se cuelan campos de solo lectura ni los nombres de lectura.
        expect(o).not.toHaveProperty('offer_id');
        expect(o).not.toHaveProperty('available_start_date');
        expect(o).not.toHaveProperty('product_title');
    });

    it('un stock de 0 se manda como 0 (no se confunde con «no cambiar»)', () => {
        expect(armarOfertaParaEnviar(ofertaActual(), { stock: 0 }).quantity).toBe(0);
    });

    it('sin precio nuevo conserva el de Ripley; con precio nuevo lo cambia', () => {
        expect(armarOfertaParaEnviar(ofertaActual(), { stock: 4, price: null }).price).toBe(89.9);
        expect(armarOfertaParaEnviar(ofertaActual(), { stock: 4, price: 95 }).price).toBe(95);
    });

    it('rechaza stock o precio no válidos', () => {
        expect(() => armarOfertaParaEnviar(ofertaActual(), { stock: -1 })).toThrow(/Stock no válido/);
        expect(() => armarOfertaParaEnviar(ofertaActual(), { stock: 1.5 })).toThrow(/Stock no válido/);
        expect(() => armarOfertaParaEnviar(ofertaActual(), { stock: 1, price: 0 })).toThrow(/Precio no válido/);
    });

    it('no toca ofertas con precios por canal, por volumen o descuentos por cantidad', () => {
        expect(motivoParaNoTocarOferta({ ...ofertaActual(), all_prices: [{ channel_code: 'WEB' }] })).toMatch(/por canal/);
        expect(motivoParaNoTocarOferta({ ...ofertaActual(), all_prices: [{ channel_code: null, volume_prices: [{ quantity_threshold: 2 }] }] })).toMatch(/por volumen/);
        expect(motivoParaNoTocarOferta({ ...ofertaActual(), discount: { discount_price: 1, ranges: [{ quantity_threshold: 2, price: 1 }] } })).toMatch(/por cantidad/);
        expect(() => armarOfertaParaEnviar({ ...ofertaActual(), state_code: undefined }, { stock: 1 })).toThrow(/state_code/);
    });

    it('resumen: solo stock y precio', () => {
        const act = ofertaActual();
        expect(resumenDeCambios(act, armarOfertaParaEnviar(act, { stock: 4 }))).toEqual({ stock: { antes: 5, despues: 4 }, precio: { antes: 89.9, despues: 89.9 } });
    });
});

describe('skuPermitidoParaRipley', () => {
    it('sin lista no se envía ninguno; con lista solo esos; con * todos', () => {
        expect(skuPermitidoParaRipley('A', undefined)).toBe(false);
        expect(skuPermitidoParaRipley('A', '  ')).toBe(false);
        expect(skuPermitidoParaRipley('23090102', '23090102, X1')).toBe(true);
        expect(skuPermitidoParaRipley('X1', '23090102, X1')).toBe(true);
        expect(skuPermitidoParaRipley('23090103', '23090102')).toBe(false);
        expect(skuPermitidoParaRipley('cualquiera', '*')).toBe(true);
    });
});

describe('RipleyApiService.setInventory', () => {
    const auth = { site: 'ripleyperu-prod.mirakl.net', token: 'clave-de-prueba-1234567890' };
    let get: jest.SpyInstance;
    let post: jest.SpyInstance;
    beforeEach(() => {
        jest.useFakeTimers();
        get = jest.spyOn(axios, 'get');
        post = jest.spyOn(axios, 'post');
    });
    afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

    const correr = async (p: Promise<void>) => { await jest.advanceTimersByTimeAsync(9000); return p; };

    it('lee la oferta, manda la oferta completa por POST y comprueba la importación', async () => {
        get.mockImplementation(async (url: string) => {
            if (url.endsWith('/api/offers')) return { data: { offers: [ofertaActual()] } };
            return { data: { status: 'COMPLETE', lines_in_error: 0 } };
        });
        post.mockResolvedValue({ data: { import_id: 55 } });
        const p = new RipleyApiService().setInventory(auth, { externalId: '777', variationId: null, sku: '23090102' }, { stock: 4, price: null });
        await correr(p);
        const cuerpo = post.mock.calls[0][1];
        expect(post.mock.calls[0][0]).toBe('https://ripleyperu-prod.mirakl.net/api/offers');
        expect(cuerpo.offers).toHaveLength(1);
        expect(cuerpo.offers[0]).toMatchObject({ shop_sku: '23090102', quantity: 4, price: 89.9, description: 'Bolso de cuero', logistic_class: 'L1' });
    });

    it('si Ripley reporta errores en la importación, lanza con el motivo', async () => {
        get.mockImplementation(async (url: string) => {
            if (url.endsWith('/api/offers')) return { data: { offers: [ofertaActual()] } };
            if (url.endsWith('/error_report')) return { data: 'line;error\n2;state_code invalido' };
            return { data: { status: 'COMPLETE', lines_in_error: 1, has_error_report: true } };
        });
        post.mockResolvedValue({ data: { import_id: 56 } });
        const p = new RipleyApiService().setInventory(auth, { externalId: '777', variationId: null, sku: '23090102' }, { stock: 4 });
        const resultado = expect(p).rejects.toThrow(/rechazó el cambio.*state_code invalido/);
        await jest.advanceTimersByTimeAsync(9000);
        await resultado;
    });

    it('no envía nada si el SKU ahora apunta a otra oferta que la enlazada, ni si falta el SKU', async () => {
        get.mockResolvedValue({ data: { offers: [{ ...ofertaActual(), offer_id: 999 }] } });
        await expect(new RipleyApiService().setInventory(auth, { externalId: '777', variationId: null, sku: '23090102' }, { stock: 4 })).rejects.toThrow(/otra oferta/);
        await expect(new RipleyApiService().setInventory(auth, { externalId: '777', variationId: null }, { stock: 4 })).rejects.toThrow(/Falta el SKU/);
        expect(post).not.toHaveBeenCalled();
    });

    it('no envía nada si Ripley no tiene ese SKU', async () => {
        get.mockResolvedValue({ data: { offers: [] } });
        await expect(new RipleyApiService().setInventory(auth, { externalId: '777', variationId: null, sku: 'NOEXISTE' }, { stock: 4 })).rejects.toThrow(/no tiene una oferta/);
        expect(post).not.toHaveBeenCalled();
    });
});
