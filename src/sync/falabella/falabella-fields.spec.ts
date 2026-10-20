import { ATRIBUTOS_DE_SISTEMA, atributosQueNoAplican, claveDeAtributo, leerAtributosNoAplicables } from './falabella-fields';

describe('campos de sistema de Falabella', () => {
    it('ParentSku, TaxClass y ShipmentType no se envían como atributos del producto', () => {
        for (const n of ['parent_sku', 'tax_class', 'shipment_type', 'product_id']) expect(ATRIBUTOS_DE_SISTEMA.has(n)).toBe(true);
    });

    it('los reconoce escritos de cualquier forma: TaxClass, taxclass, tax-class, Shipment_Type…', () => {
        for (const n of ['TaxClass', 'taxclass', 'tax-class', 'Tax_Class', 'ShipmentType', 'shipment-type', 'ParentSku', 'PARENT_SKU']) {
            expect(ATRIBUTOS_DE_SISTEMA.has(n)).toBe(true);
        }
        expect(ATRIBUTOS_DE_SISTEMA.has('Material')).toBe(false);
        expect(ATRIBUTOS_DE_SISTEMA.has('color')).toBe(false);
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

import { leerLimitesDeLongitud, limiteDeLongitud, recortarTexto } from './falabella-fields';

describe('límites de longitud de atributos de Falabella', () => {
    const largo = 'Set de utensilios de cocina Kasari (espátulas, cucharas y cucharones, cuchara para espaguetis, brocha de cocina, batidor manual, pinzas para alimentos) + soporte organizador';

    it('conoce el límite de «Contenido del paquete» (172)', () => {
        expect(limiteDeLongitud({ name: 'Contenido del paquete', feedName: 'PackageContent' }, null)).toBe(172);
        expect(limiteDeLongitud({ name: 'Color', feedName: 'Color' }, null)).toBeUndefined();
    });

    it('usa el límite aprendido de un rechazo anterior', () => {
        expect(limiteDeLongitud({ name: 'Garantía', feedName: 'Warranty' }, { _maxLen: { [claveDeAtributo('Garantía')]: 40 } })).toBe(40);
    });

    it('lee del mensaje de Falabella el valor y su máximo', () => {
        const r = leerLimitesDeLongitud(`0: '${largo}' is more than 172 characters long`);
        expect(r).toEqual([{ valor: largo, max: 172 }]);
        expect(leerLimitesDeLongitud('0: otra cosa')).toEqual([]);
    });

    it('acorta sin pasarse, sin partir palabras ni dejar paréntesis abiertos', () => {
        const corto = recortarTexto(largo, 172);
        expect(corto.length).toBeLessThanOrEqual(172);
        expect((corto.match(/\(/g) ?? []).length).toBe((corto.match(/\)/g) ?? []).length);
        expect(largo.startsWith(corto.replace(/\)+$/, ''))).toBe(true);
        expect(recortarTexto('Texto corto', 172)).toBe('Texto corto');
    });
});
