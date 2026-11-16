import { canalesNombrados, mencionaOtroCanal } from './otro-canal';

describe('otro-canal', () => {
    it('detecta los nombres de canal con sus variantes de escritura', () => {
        expect(canalesNombrados('Garantía según las políticas de Mercado Libre.')).toEqual(['mercadolibre']);
        expect(canalesNombrados('vendido en MercadoLibre y Falabella').sort()).toEqual(['falabella', 'mercadolibre']);
        expect(canalesNombrados('Toalla de baño 100% algodón')).toEqual([]);
        expect(canalesNombrados(undefined)).toEqual([]);
    });

    it('un texto que nombra a otro canal no sirve para este', () => {
        expect(mencionaOtroCanal('Garantía según las políticas de Mercado Libre.', 'falabella')).toBe(true);
        expect(mencionaOtroCanal('Garantía según las políticas de Mercado Libre.', 'mercadolibre')).toBe(false);
        expect(mencionaOtroCanal('Garantía del proveedor: 1 mes', 'falabella')).toBe(false);
    });

    it('sin canal indicado, cualquier mención cuenta', () => {
        expect(mencionaOtroCanal('Envío por Ripley')).toBe(true);
        expect(mencionaOtroCanal('Envío rápido')).toBe(false);
    });
});
