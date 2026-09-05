import * as ExcelJS from 'exceljs';
import { leerPrimeraHoja, escribirHoja } from './excel';

/**
 * Estas pruebas fijan el comportamiento que tenía SheetJS antes de cambiar a
 * ExcelJS. La carga masiva de productos depende de que leer una hoja siga
 * dando exactamente lo mismo; si algo cambia aquí, se rompe en silencio la
 * importación de catálogos de los clientes.
 */

/** Construye un .xlsx en memoria a partir de filas sueltas. */
async function hojaDePrueba(filas: any[][]): Promise<Buffer> {
    const libro = new ExcelJS.Workbook();
    const hoja = libro.addWorksheet('Datos');
    for (const fila of filas) hoja.addRow(fila);
    return Buffer.from(await libro.xlsx.writeBuffer());
}

describe('leerPrimeraHoja', () => {
    it('usa la primera fila como nombres de columna', async () => {
        const buffer = await hojaDePrueba([
            ['sku', 'nombre', 'precio'],
            ['ABC-1', 'Gafas', 149.99],
        ]);

        expect(await leerPrimeraHoja(buffer)).toEqual([
            { sku: 'ABC-1', nombre: 'Gafas', precio: 149.99 },
        ]);
    });

    it('omite las celdas vacías en vez de dejarlas en blanco', async () => {
        // La carga masiva comprueba `if (row.precio)`. Si una celda vacía
        // llegara como '' la comprobación seguiría funcionando, pero si
        // llegara como 0 no, así que la clave no debe existir.
        const buffer = await hojaDePrueba([
            ['sku', 'nombre', 'precio'],
            ['ABC-1', 'Gafas', null],
        ]);

        const filas = await leerPrimeraHoja(buffer);
        expect(filas).toHaveLength(1);
        expect('precio' in filas[0]).toBe(false);
    });

    it('se salta las filas completamente vacías', async () => {
        const buffer = await hojaDePrueba([
            ['sku', 'nombre'],
            ['ABC-1', 'Gafas'],
            [],
            ['ABC-2', 'Relojes'],
        ]);

        expect(await leerPrimeraHoja(buffer)).toEqual([
            { sku: 'ABC-1', nombre: 'Gafas' },
            { sku: 'ABC-2', nombre: 'Relojes' },
        ]);
    });

    it('devuelve el resultado de una fórmula, no la fórmula', async () => {
        const libro = new ExcelJS.Workbook();
        const hoja = libro.addWorksheet('Datos');
        hoja.addRow(['sku', 'total']);
        const fila = hoja.addRow(['ABC-1', null]);
        fila.getCell(2).value = { formula: 'A2&"-x"', result: 'ABC-1-x' } as any;
        const buffer = Buffer.from(await libro.xlsx.writeBuffer());

        const filas = await leerPrimeraHoja(buffer);
        expect(filas[0].total).toBe('ABC-1-x');
    });

    it('junta el texto con formato en una sola cadena', async () => {
        const libro = new ExcelJS.Workbook();
        const hoja = libro.addWorksheet('Datos');
        hoja.addRow(['sku', 'nombre']);
        const fila = hoja.addRow(['ABC-1', null]);
        fila.getCell(2).value = {
            richText: [{ text: 'Gafas ' }, { text: 'Levis' }],
        } as any;
        const buffer = Buffer.from(await libro.xlsx.writeBuffer());

        const filas = await leerPrimeraHoja(buffer);
        expect(filas[0].nombre).toBe('Gafas Levis');
    });

    it('de una celda con enlace se queda con el texto visible', async () => {
        // En las hojas reales de los clientes las URLs suelen venir como
        // hipervínculo. Sin esto se guardaría "[object Object]".
        const libro = new ExcelJS.Workbook();
        const hoja = libro.addWorksheet('Datos');
        hoja.addRow(['sku', 'enlace']);
        const fila = hoja.addRow(['ABC-1', null]);
        fila.getCell(2).value = {
            text: 'https://ejemplo.com/p/1',
            hyperlink: 'https://ejemplo.com/p/1',
        } as any;
        const buffer = Buffer.from(await libro.xlsx.writeBuffer());

        const filas = await leerPrimeraHoja(buffer);
        expect(filas[0].enlace).toBe('https://ejemplo.com/p/1');
    });

    it('trata las celdas con error como vacías', async () => {
        const libro = new ExcelJS.Workbook();
        const hoja = libro.addWorksheet('Datos');
        hoja.addRow(['sku', 'precio']);
        const fila = hoja.addRow(['ABC-1', null]);
        fila.getCell(2).value = { error: '#N/A' } as any;
        const buffer = Buffer.from(await libro.xlsx.writeBuffer());

        const filas = await leerPrimeraHoja(buffer);
        expect('precio' in filas[0]).toBe(false);
    });

    it('recorta los espacios de los nombres de columna', async () => {
        // La hoja real del cliente tiene una columna llamada "Estado " con un
        // espacio al final.
        const buffer = await hojaDePrueba([
            ['  sku  ', 'Estado '],
            ['ABC-1', 'Visible'],
        ]);

        expect(await leerPrimeraHoja(buffer)).toEqual([
            { sku: 'ABC-1', Estado: 'Visible' },
        ]);
    });

    it('devuelve lista vacía si la hoja no tiene nada', async () => {
        expect(await leerPrimeraHoja(await hojaDePrueba([]))).toEqual([]);
    });

    it('devuelve lista vacía si solo hay cabeceras', async () => {
        expect(await leerPrimeraHoja(await hojaDePrueba([['sku', 'nombre']]))).toEqual([]);
    });
});

describe('escribirHoja', () => {
    it('lo que se escribe se puede volver a leer igual', async () => {
        const datos = [
            { sku: 'ABC-1', nombre: 'Gafas', precio: 149.99 },
            { sku: 'ABC-2', nombre: 'Relojes', precio: 89.5 },
        ];

        const leido = await leerPrimeraHoja(await escribirHoja(datos, 'Productos'));
        expect(leido).toEqual(datos);
    });

    it('limpia los caracteres que Excel no admite en el nombre de la hoja', async () => {
        // Con estos signos el archivo se abre dañado y el cliente cree que
        // la exportación falló.
        const buffer = await escribirHoja([{ a: 1 }], 'Ventas/2026*[Q1]');

        const libro = new ExcelJS.Workbook();
        await libro.xlsx.load(buffer as any);
        expect(libro.worksheets[0].name).toBe('Ventas-2026--Q1-');
    });

    it('recorta el nombre de hoja a los 31 caracteres que permite Excel', async () => {
        const buffer = await escribirHoja([{ a: 1 }], 'x'.repeat(60));

        const libro = new ExcelJS.Workbook();
        await libro.xlsx.load(buffer as any);
        expect(libro.worksheets[0].name).toHaveLength(31);
    });

    it('no revienta con una lista vacía', async () => {
        const buffer = await escribirHoja([], 'Vacío');
        expect(await leerPrimeraHoja(buffer)).toEqual([]);
    });
});
