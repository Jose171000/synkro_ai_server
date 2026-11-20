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
        expect(hoja.getRow(1).values).toEqual([undefined, 'sku', 'precio', 'stock', 'fotos', 'nombre', 'descripcion', 'canales', 'precio_descuento', 'descuento_desde', 'descuento_hasta', 'sku_padre', 'eje_1', 'valor_1', 'eje_2', 'valor_2', 'eje_3', 'valor_3']);
        // El ejemplo trae un producto con variantes: dos filas con el mismo sku_padre; el eje solo en la primera.
        expect([hoja.getCell('K4').value, hoja.getCell('L4').value, hoja.getCell('M4').value]).toEqual(['EJEMPLO-GRUPO', 'Medida', '1.5 plazas']);
        expect([hoja.getCell('K5').value, hoja.getCell('L5').value, hoja.getCell('M5').value]).toEqual(['EJEMPLO-GRUPO', null, '2 plazas']);
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
