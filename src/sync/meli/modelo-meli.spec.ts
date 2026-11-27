import { modeloParaMeli } from './modelo-meli';
import { fichaSinSku, porSku } from '../../ai/fichas-sin-sku';

const producto = (over: any = {}) => ({ sku: 'XR2400065', name: 'miau smart duo', aiAttributes: {}, ...over }) as any;

describe('el SKU es de manejo interno', () => {
    it('el modelo de Mercado Libre es el escrito o el nombre, nunca el SKU ni el código del grupo', () => {
        expect(modeloParaMeli(producto(), {})).toBe('miau smart duo');
        expect(modeloParaMeli(producto(), { MODEL: 'Smart Duo 2' })).toBe('Smart Duo 2');
        expect(modeloParaMeli(producto(), { MODEL: 'xr2400065' })).toBe('miau smart duo');
        expect(modeloParaMeli(producto({ group: { parentSku: 'GRP-1', name: 'Correa doble' }, name: 'Correa doble - Rojo' }), { MODEL: 'GRP-1' })).toBe('Correa doble');
    });

    it('al deducir variantes la IA no ve ningún SKU y la respuesta vuelve a cada ficha', () => {
        const ficha = { sellerSku: 'CAM-AZ-01', nombre: 'Cama azul CAM-AZ-01', variation: 'CAM-AZ-01', atributos: { SellerSku: 'CAM-AZ-01', Color: 'Azul', Codigo: 'cam-az-01' } };
        const enviada = fichaSinSku(ficha, 'F1');
        expect(enviada.toLowerCase()).not.toContain('cam-az-01');
        expect(enviada).toContain('"Color":"Azul"');
        expect(porSku({ F1: { Color: 'Azul' } }, [ficha])).toEqual({ 'CAM-AZ-01': { Color: 'Azul' } });
    });
});
