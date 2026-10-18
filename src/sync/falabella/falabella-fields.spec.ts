import { ATRIBUTOS_DE_SISTEMA, atributosQueNoAplican, claveDeAtributo, leerAtributosNoAplicables } from './falabella-fields';

describe('campos de sistema de Falabella', () => {
    it('ParentSku, TaxClass y ShipmentType no se envían como atributos del producto', () => {
        for (const n of ['parent_sku', 'tax_class', 'shipment_type', 'product_id']) expect(ATRIBUTOS_DE_SISTEMA.has(n)).toBe(true);
    });

    it('lee del mensaje de Falabella qué atributos no aplican a la categoría', () => {
        expect(leerAtributosNoAplicables('0: ParentSku, TaxClass, ShipmentType is/are not applicable to Bebés'))
            .toEqual(['ParentSku', 'TaxClass', 'ShipmentType']);
        expect(leerAtributosNoAplicables('Color is/are not applicable to Hogar')).toEqual(['Color']);
        expect(leerAtributosNoAplicables('0: Esta marca no existe en nuestra base de datos')).toEqual([]);
        expect(leerAtributosNoAplicables(null)).toEqual([]);
    });

    it('compara nombres sin importar mayúsculas, guiones ni guiones bajos', () => {
        expect(claveDeAtributo('TaxClass')).toBe(claveDeAtributo('tax_class'));
        const set = atributosQueNoAplican({ _noAplica: ['ParentSku', 'tax_class'] });
        expect(set.has(claveDeAtributo('parent_sku'))).toBe(true);
        expect(set.has(claveDeAtributo('TaxClass'))).toBe(true);
        expect(atributosQueNoAplican(null).size).toBe(0);
    });
});
