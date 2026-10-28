import * as ExcelJS from 'exceljs';
import { combinacionesDeCanales, nombreDeArchivo, plantillaDeProductos } from './product-template';

describe('plantilla de productos por tienda', () => {
    it('el archivo lleva el nombre de la tienda', () => {
        expect(nombreDeArchivo('Maba Kids')).toBe('plantilla-productos-maba-kids.xlsx');
        expect(nombreDeArchivo('Corporación Médica')).toBe('plantilla-productos-corporacion-medica.xlsx');
        expect(nombreDeArchivo('')).toBe('plantilla-productos.xlsx');
    });

    it('la lista de canales ofrece cada canal conectado y sus combinaciones', () => {
        expect(combinacionesDeCanales(['falabella'])).toEqual(['falabella']);
        expect(combinacionesDeCanales(['falabella', 'mercadolibre'])).toEqual(['falabella', 'mercadolibre', 'falabella,mercadolibre']);
        expect(combinacionesDeCanales([])).toEqual([]);
    });

    it('genera un Excel válido con la lista desplegable solo con los canales conectados', async () => {
        const buffer = await plantillaDeProductos('Maba Kids', ['falabella']);
        const libro = new ExcelJS.Workbook();
        await libro.xlsx.load(buffer as any);
        const hoja = libro.getWorksheet('Productos')!;
        expect(hoja.getRow(1).values).toEqual([undefined, 'sku', 'precio', 'stock', 'fotos', 'nombre', 'descripcion', 'canales', 'precio_descuento', 'descuento_desde', 'descuento_hasta']);
        expect(hoja.getCell('G5').dataValidation.formulae).toEqual(['Listas!$A$1:$A$1']);
        expect(libro.getWorksheet('Listas')!.getCell('A1').value).toBe('falabella');
        expect(libro.getWorksheet('Instrucciones')!.getCell('A1').value).toContain('Maba Kids');
    });

    it('con dos canales la combinación va completa en una sola opción de la lista', async () => {
        const buffer = await plantillaDeProductos('Kassari', ['falabella', 'mercadolibre']);
        const libro = new ExcelJS.Workbook();
        await libro.xlsx.load(buffer as any);
        const lista = libro.getWorksheet('Listas')!;
        expect([1, 2, 3].map((i) => lista.getCell(`A${i}`).value)).toEqual(['falabella', 'mercadolibre', 'falabella,mercadolibre']);
        expect(libro.getWorksheet('Productos')!.getCell('G5').dataValidation.formulae).toEqual(['Listas!$A$1:$A$3']);
        expect(libro.getWorksheet('Productos')!.getCell('G2').value).toBe('falabella,mercadolibre');
    });
});
