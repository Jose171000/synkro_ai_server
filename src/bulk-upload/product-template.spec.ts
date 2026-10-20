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
        expect(hoja.getRow(1).values).toEqual([undefined, 'sku', 'precio', 'stock', 'fotos', 'nombre', 'descripcion', 'canales']);
        expect(hoja.getCell('G5').dataValidation.formulae).toEqual(['"falabella"']);
        expect(libro.getWorksheet('Instrucciones')!.getCell('A1').value).toContain('Maba Kids');
    });
});
