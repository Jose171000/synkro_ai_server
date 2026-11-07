import ExcelJS = require('exceljs');
import { calcularCambios, columnasReconocidas, leerFilasDeEdicion } from './edicion-masiva';
import { EdicionMasivaService } from './edicion-masiva.service';

describe('edición masiva: lectura de filas', () => {
    it('una celda vacía no toca; acepta español e inglés', () => {
        const [f] = leerFilasDeEdicion([{ SKU: 'A-1', Nombre: 'Bolso nuevo', Price: 'S/ 1.250,50', Stock: '' }]);
        expect(f).toEqual({ sku: 'A-1', nombre: 'Bolso nuevo', precio: 1250.5, errores: [] });
    });
    it('marca precio o stock inválidos, SKU faltante y SKU repetido', () => {
        const filas = leerFilasDeEdicion([
            { sku: 'A', precio: 'abc' },
            { sku: 'B', stock: '-3' },
            { precio: 10 },
            { sku: 'a', precio: 10 },
            { sku: 'A', precio: 12 },
        ]);
        expect(filas[0].errores[0]).toMatch(/Precio no válido/);
        expect(filas[1].errores[0]).toMatch(/Stock no válido/);
        expect(filas[2].errores).toEqual(['Falta el SKU.']);
        expect(filas[3].errores).toEqual(['El SKU está repetido en el archivo.']); // «a» y «A» son el mismo SKU
        expect(filas[4].errores).toEqual(['El SKU está repetido en el archivo.']);
    });
    it('reconoce las columnas que se pueden editar', () => {
        expect(columnasReconocidas([{ SKU: 'A', Stock: 1, Nombre: 'x' }])).toEqual(['nombre', 'stock']);
        expect(columnasReconocidas([{ SKU: 'A' }])).toEqual([]);
    });
});

describe('edición masiva: qué cambia', () => {
    const actual = { name: 'Bolso', price: '89.00' as any, stock: 5, description: 'Bonito' };
    it('solo lista lo que de verdad es distinto', () => {
        const [f] = leerFilasDeEdicion([{ sku: 'A', nombre: 'Bolso', precio: 89, stock: 8 }]);
        expect(calcularCambios(f, actual)).toEqual([{ campo: 'stock', antes: 5, despues: 8 }]);
    });
    it('sin cambios devuelve vacío', () => {
        const [f] = leerFilasDeEdicion([{ sku: 'A', precio: 89 }]);
        expect(calcularCambios(f, actual)).toEqual([]);
    });
});

describe('EdicionMasivaService', () => {
    async function excel(filas: any[][]): Promise<Buffer> {
        const libro = new ExcelJS.Workbook();
        const h = libro.addWorksheet('P');
        filas.forEach((f) => h.addRow(f));
        return Buffer.from(await libro.xlsx.writeBuffer());
    }
    const armar = () => {
        const existentes = [
            { id: 'p1', sku: 'A-1', name: 'Bolso', price: '89.00', stock: 5, description: '' },
            { id: 'p2', sku: 'B-2', name: 'Morral', price: '50.00', stock: 2, description: '' },
        ];
        const repo = { find: jest.fn(async () => existentes), update: jest.fn(async () => undefined) };
        const sync = { updateInventory: jest.fn(async () => ({ pending: 1, message: 'x' })) };
        return { servicio: new EdicionMasivaService(repo as any, sync as any), repo, sync };
    };
    const scope = { userId: 'u', storeId: 's' };

    it('la vista previa cuenta cambios y no escribe nada', async () => {
        const { servicio, repo, sync } = armar();
        const buf = await excel([['SKU', 'Nombre', 'Precio', 'Stock'], ['A-1', 'Bolso XL', 99, 5], ['B-2', 'Morral', 50, 2], ['ZZZ', 'x', 1, 1]]);
        const r = await servicio.procesar(scope, buf, false, true);
        expect(r).toMatchObject({ aplicado: false, totalFilas: 3, conCambios: 1, sinCambios: 1, noEncontrados: ['ZZZ'] });
        expect(r.cambios[0].cambios.map((c) => c.campo)).toEqual(['nombre', 'precio']);
        expect(repo.update).not.toHaveBeenCalled();
        expect(sync.updateInventory).not.toHaveBeenCalled();
    });

    it('al aplicar, nombre va directo y precio/stock pasan por updateInventory (modo revisión)', async () => {
        const { servicio, repo, sync } = armar();
        const buf = await excel([['SKU', 'Nombre', 'Precio', 'Stock'], ['A-1', 'Bolso XL', 99, 7]]);
        const r = await servicio.procesar(scope, buf, true, true);
        expect(repo.update).toHaveBeenCalledWith({ id: 'p1' }, { name: 'Bolso XL' });
        expect(sync.updateInventory).toHaveBeenCalledWith(scope, 'p1', { stock: 7, price: 99 });
        expect(r).toMatchObject({ actualizados: 1, enRevision: 1 });
    });

    it('un rol sin permiso de inventario no puede cambiar precio ni stock', async () => {
        const { servicio, sync } = armar();
        const buf = await excel([['SKU', 'Stock'], ['A-1', 9]]);
        const r = await servicio.procesar(scope, buf, true, false);
        expect(r.errores[0].mensaje).toMatch(/no puede cambiar precio ni stock/);
        expect(sync.updateInventory).not.toHaveBeenCalled();
    });

    it('un Excel sin columnas editables o vacío se rechaza', async () => {
        const { servicio } = armar();
        await expect(servicio.procesar(scope, await excel([['SKU'], ['A-1']]), false, true)).rejects.toThrow(/ninguna columna/);
        await expect(servicio.procesar(scope, await excel([['SKU', 'Stock']]), false, true)).rejects.toThrow(/vacío/);
    });

    it('la plantilla trae los productos de la tienda', async () => {
        const { servicio } = armar();
        const libro = new ExcelJS.Workbook();
        await libro.xlsx.load((await servicio.plantilla('s')) as any);
        expect(libro.worksheets.map((h) => h.name)).toEqual(['Productos', 'Cómo usar']);
        expect(libro.getWorksheet('Productos')!.getRow(2).getCell(1).value).toBe('A-1');
        expect(libro.getWorksheet('Productos')!.getRow(2).getCell(3).value).toBe(89);
    });
});
