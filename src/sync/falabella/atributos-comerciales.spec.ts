import { esAtributoDeSistema } from './falabella-fields';

/**
 * El precio, el precio de oferta, el stock y las fechas de la oferta los fija Synkro desde lo que digitó el cliente:
 * la IA no los completa y no aparecen como datos editables de la ficha del canal.
 */
describe('atributos que no se completan con IA', () => {
    it.each([
        { name: 'FaStock', label: 'Stock (Falabella)' },
        { name: 'FaPrice', label: 'Precio (Falabella)' },
        { name: 'FaSpecialPrice', label: 'Precio de oferta (Falabella)' },
        { name: 'FaSpecialFromDate', label: 'Fecha de inicio precio de oferta (Falabella)' },
        { name: 'FaSpecialToDate', label: 'Fecha de fin precio de oferta (Falabella)' },
        // Aunque el nombre técnico sea otro, la etiqueta lo delata.
        { name: 'XyzA', label: 'Precio (Falabella)' },
        { name: 'OtroNombre', label: 'Stock (Falabella)' },
    ])('$label se reconoce como dato comercial', (a) => {
        expect(esAtributoDeSistema(a)).toBe(true);
    });

    it.each([
        { name: 'sale_price', label: 'Precio de venta' },
        { name: 'SpecialPrice', label: '' },
        { name: 'Stock', label: '' },
        { name: 'tax_class', label: '' },
    ])('los campos de sistema y de precio por nombre también ($name)', (a) => {
        expect(esAtributoDeSistema(a)).toBe(true);
    });

    it.each([
        { name: 'MadeIn', label: 'Hecho en' },
        { name: 'Color', label: 'Color' },
        { name: 'Material', label: 'Material' },
        { name: 'PackageContent', label: 'Contenido del paquete' },
        { name: 'RecommendedAge', label: 'Edad recomendada' },
    ])('$label sigue siendo un dato del producto', (a) => {
        expect(esAtributoDeSistema(a)).toBe(false);
    });
});
