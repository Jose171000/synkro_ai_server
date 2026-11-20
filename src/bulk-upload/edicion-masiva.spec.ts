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
        const sync = {
            updateInventory: jest.fn(async () => ({ pending: 1, message: 'x' })),
            aplicarDescuentoGeneral: jest.fn(async () => ({ total: 1, aplicados: 1, fallidos: 0, resultados: [{ productId: 'p1', ok: true, message: 'ok' }] })),
            quitarDescuentoGeneral: jest.fn(async () => ({ total: 1, quitados: 1, fallidos: 0, resultados: [{ productId: 'p1', ok: true, message: 'ok' }] })),
        };
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
        expect(r.errores[0].mensaje).toMatch(/no puede cambiar precio, stock ni descuentos/);
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

describe('descuento en el Excel', () => {
    const HASTA = '2099-12-31';
    const actual = { name: 'Bolso', price: '100.00', stock: 5, description: '', salePrice: null, saleEndDate: null };

    it('lee porcentaje o precio con descuento y la fecha de fin (texto, DD/MM/AAAA o fecha de Excel)', () => {
        const [a, b, c, d] = leerFilasDeEdicion([
            { SKU: 'A', 'Descuento %': '15%', 'Descuento hasta': HASTA },
            { SKU: 'B', 'Precio con descuento': 79.9, 'Descuento desde': '01/12/2098', 'Descuento hasta': '31/12/2099' },
            { SKU: 'C', 'Descuento %': 0.2, 'Descuento hasta': new Date('2099-06-30T00:00:00Z') },
            { SKU: 'D', 'Descuento %': 10, 'Descuento hasta': '31-12-2099' },
        ]);
        expect(a.descuento).toEqual({ modo: 'porcentaje', valor: 15, hasta: HASTA });
        expect(b.descuento).toEqual({ modo: 'precio', valor: 79.9, desde: '2098-12-01', hasta: '2099-12-31' });
        expect(c.descuento).toMatchObject({ modo: 'porcentaje', valor: 20, hasta: '2099-06-30' }); // 0.2 = «20%» con formato de Excel
        expect(d.descuento?.hasta).toBe('2099-12-31');
        expect([a, b, c, d].every((f) => f.errores.length === 0)).toBe(true);
    });

    it('sin fecha de fin, con los dos tipos a la vez o con fechas sueltas es un error de la fila', () => {
        const [sinFin, ambos, suelta, malaFecha] = leerFilasDeEdicion([
            { SKU: 'A', 'Descuento %': 10 },
            { SKU: 'B', 'Descuento %': 10, 'Precio con descuento': 50, 'Descuento hasta': HASTA },
            { SKU: 'C', 'Descuento hasta': HASTA },
            { SKU: 'D', 'Descuento %': 10, 'Descuento hasta': '2099-02-30' },
        ]);
        expect(sinFin.errores.join()).toMatch(/necesita «Descuento hasta»/);
        expect(ambos.errores.join()).toMatch(/porcentaje o en soles, no los dos/);
        expect(suelta.errores.join()).toMatch(/falta el porcentaje o el precio/);
        expect(malaFecha.errores.join()).toMatch(/no es una fecha válida/);
        expect([sinFin, ambos, suelta, malaFecha].every((f) => !f.descuento)).toBe(true);
    });

    it('«Quitar descuento: sí» marca quitar, y no se mezcla con poner uno', () => {
        const [quitar, mezcla, no] = leerFilasDeEdicion([
            { SKU: 'A', 'Quitar descuento': 'sí' },
            { SKU: 'B', 'Quitar descuento': 'x', 'Descuento %': 10, 'Descuento hasta': HASTA },
            { SKU: 'C', 'Quitar descuento': 'no' },
        ]);
        expect(quitar.quitarDescuento).toBe(true);
        expect(mezcla.errores.join()).toMatch(/quitar y poner/);
        expect(no.quitarDescuento).toBeUndefined();
    });

    it('calcula el precio con descuento sobre el precio nuevo de la misma fila y no repite uno igual', () => {
        const [f] = leerFilasDeEdicion([{ SKU: 'A', Precio: 200, 'Descuento %': 25, 'Descuento hasta': HASTA }]);
        const cambios = calcularCambios(f, actual);
        expect(cambios.map((c) => c.campo)).toEqual(['precio', 'descuento']);
        expect(String(cambios[1].despues)).toContain('150.00 (25% menos)');
        const [g] = leerFilasDeEdicion([{ SKU: 'A', 'Precio con descuento': 80, 'Descuento hasta': HASTA }]);
        expect(calcularCambios(g, { ...actual, salePrice: '80.00', saleEndDate: HASTA })).toEqual([]);
    });

    it('un descuento que no rebaja el precio lanza el motivo', () => {
        const [f] = leerFilasDeEdicion([{ SKU: 'A', 'Precio con descuento': 120, 'Descuento hasta': HASTA }]);
        expect(() => calcularCambios(f, actual)).toThrow(/menor que el precio regular/);
    });
});

describe('EdicionMasivaService · descuento', () => {
    async function excel(filas: any[][]): Promise<Buffer> {
        const libro = new ExcelJS.Workbook();
        const h = libro.addWorksheet('P');
        filas.forEach((f) => h.addRow(f));
        return Buffer.from(await libro.xlsx.writeBuffer());
    }
    const prod = (id: string, sku: string, price: string, salePrice: string | null = null, saleEndDate: string | null = null) =>
        ({ id, sku, name: 'N-' + sku, price, stock: 5, description: '', salePrice, saleEndDate });
    const armar = (existentes: any[] = [prod('p1', 'A-1', '100.00')]) => {
        const repo = { find: jest.fn(async () => existentes), update: jest.fn(async () => undefined) };
        const sync = {
            updateInventory: jest.fn(async () => ({ message: 'x' })),
            aplicarDescuentoGeneral: jest.fn(async () => ({ total: 1, aplicados: 1, fallidos: 0, resultados: [{ productId: 'p1', ok: true, message: 'ok' }] })),
            quitarDescuentoGeneral: jest.fn(async () => ({ total: 1, quitados: 1, fallidos: 0, resultados: [{ productId: 'p1', ok: true, message: 'ok' }] })),
        };
        return { servicio: new EdicionMasivaService(repo as any, sync as any), sync };
    };
    const scope = { userId: 'u', storeId: 's' };

    it('la vista previa muestra el descuento y no envía nada', async () => {
        const { servicio, sync } = armar();
        const r = await servicio.procesar(scope, await excel([['SKU', 'Descuento %', 'Descuento hasta'], ['A-1', 20, '2099-12-31']]), false, true);
        expect(r).toMatchObject({ conCambios: 1, columnas: ['descuento'] });
        expect(r.cambios[0].cambios[0]).toMatchObject({ campo: 'descuento' });
        expect(sync.aplicarDescuentoGeneral).not.toHaveBeenCalled();
    });

    it('al aplicar manda el descuento general del producto con sus fechas', async () => {
        const { servicio, sync } = armar();
        const r = await servicio.procesar(scope, await excel([['SKU', 'Precio con descuento', 'Descuento desde', 'Descuento hasta'], ['A-1', 80, '2099-01-01', '2099-12-31']]), true, true);
        expect(sync.aplicarDescuentoGeneral).toHaveBeenCalledWith(scope, { productIds: ['p1'], modo: 'precio', valor: 80, desde: '2099-01-01', hasta: '2099-12-31' });
        expect(r.actualizados).toBe(1);
    });

    it('quitar descuento solo actúa si el producto tiene uno', async () => {
        const { servicio, sync } = armar([prod('p1', 'A-1', '100.00', '80.00', '2099-12-31'), prod('p2', 'B-2', '50.00')]);
        const r = await servicio.procesar(scope, await excel([['SKU', 'Quitar descuento'], ['A-1', 'sí'], ['B-2', 'sí']]), true, true);
        expect(sync.quitarDescuentoGeneral).toHaveBeenCalledTimes(1);
        expect(sync.quitarDescuentoGeneral).toHaveBeenCalledWith(scope, ['p1']);
        expect(r).toMatchObject({ actualizados: 1, sinCambios: 1 });
    });

    it('un descuento inválido en una fila no frena a las demás, y sin permiso de inventario no se aplica', async () => {
        const dos = [prod('p1', 'A-1', '100.00'), prod('p2', 'B-2', '50.00')];
        const { servicio, sync } = armar(dos);
        const r = await servicio.procesar(scope, await excel([['SKU', 'Precio con descuento', 'Descuento hasta'], ['A-1', 150, '2099-12-31'], ['B-2', 40, '2099-12-31']]), true, true);
        expect(r.errores).toHaveLength(1);
        expect(r.errores[0].mensaje).toMatch(/menor que el precio regular/);
        expect(sync.aplicarDescuentoGeneral).toHaveBeenCalledTimes(1);
        const sin = armar(dos);
        const r2 = await sin.servicio.procesar(scope, await excel([['SKU', 'Descuento %', 'Descuento hasta'], ['A-1', 10, '2099-12-31']]), true, false);
        expect(r2.errores[0].mensaje).toMatch(/descuentos/);
        expect(sin.sync.aplicarDescuentoGeneral).not.toHaveBeenCalled();
    });

    it('si el canal rechaza el descuento, la fila queda con error y no cuenta como actualizada', async () => {
        const { servicio, sync } = armar();
        sync.aplicarDescuentoGeneral.mockResolvedValueOnce({ total: 1, aplicados: 0, fallidos: 1, resultados: [{ productId: 'p1', ok: false, message: 'No se pudo' }] } as any);
        const r = await servicio.procesar(scope, await excel([['SKU', 'Descuento %', 'Descuento hasta'], ['A-1', 10, '2099-12-31']]), true, true);
        expect(r.actualizados).toBe(0);
        expect(r.errores[0]).toMatchObject({ sku: 'A-1', mensaje: 'No se pudo' });
    });

    it('la plantilla trae la Descripción actual; subirla sin tocar no cambia nada y editarla sí', async () => {
        const existentes = [{ ...prod('p1', 'A-1', '100.00'), description: '  Bolso de cuero  ' }, { ...prod('p2', 'B-2', '50.00'), description: 'x'.repeat(10_001) }];
        const { servicio } = armar(existentes);
        const buf = (await servicio.plantilla('s')) as any;
        const libro = new ExcelJS.Workbook();
        await libro.xlsx.load(buf);
        const hoja = libro.getWorksheet('Productos')!;
        const col = (hoja.getRow(1).values as any[]).indexOf('Descripción');
        expect(col).toBeGreaterThan(0);
        expect(hoja.getRow(2).getCell(col).value).toBe('Bolso de cuero');
        expect(hoja.getRow(3).getCell(col).value ?? null).toBeNull(); // pasa del máximo: va vacía, no se toca
        const sinTocar = await servicio.procesar(scope, buf, false, true);
        expect(sinTocar.conCambios).toBe(0);
        hoja.getRow(2).getCell(col).value = 'Bolso de cuero nuevo';
        const editado = await servicio.procesar(scope, Buffer.from(await libro.xlsx.writeBuffer()), false, true);
        expect(editado).toMatchObject({ conCambios: 1 });
        expect(editado.cambios[0].cambios[0]).toMatchObject({ campo: 'descripcion' });
    });

    it('la plantilla trae las columnas de descuento', async () => {
        const { servicio } = armar();
        const libro = new ExcelJS.Workbook();
        await libro.xlsx.load((await servicio.plantilla('s')) as any);
        const encabezados = (libro.getWorksheet('Productos')!.getRow(1).values as any[]).filter(Boolean);
        expect(encabezados).toEqual(expect.arrayContaining(['Descuento %', 'Precio con descuento', 'Descuento desde', 'Descuento hasta', 'Quitar descuento']));
    });
});
