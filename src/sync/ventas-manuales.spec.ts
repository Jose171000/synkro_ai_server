import { claveDeCanal, leerFechaManual, nombreDeCanalManual, plantillaDeVentas, ventasDeFilas } from './ventas-manuales';
import * as ExcelJS from 'exceljs';

describe('lectura de ventas manuales', () => {
    it('una fila es una venta con sus valores por defecto', () => {
        const { ventas, errores } = ventasDeFilas([{ canal: 'Ripley', sku: 'A1', precio_unitario: 50 }]);
        expect(errores).toEqual([]);
        expect(ventas[0]).toMatchObject({ canal: 'ripley', estado: 'entregado', envio: 0, moneda: 'PEN', numeroPedido: null });
        expect(ventas[0].lineas).toEqual([{ sku: 'A1', producto: null, cantidad: 1, precioUnitario: 50, descontarStock: true }]);
    });

    it('varias filas con el mismo número de pedido son líneas de una sola venta, con los datos de la primera', () => {
        const { ventas } = ventasDeFilas([
            { numero_pedido: 'R-1', canal: 'Ripley', cliente: 'Ana', sku: 'A1', cantidad: 2, precio_unitario: 10, envio: 5 },
            { numero_pedido: 'r-1', sku: 'B2', precio_unitario: 7 },
            { numero_pedido: 'R-2', canal: 'Juntoz', sku: 'C3', precio_unitario: 1 },
        ]);
        expect(ventas).toHaveLength(2);
        expect(ventas[0].lineas.map(l => l.sku)).toEqual(['A1', 'B2']);
        expect(ventas[0]).toMatchObject({ cliente: 'Ana', envio: 5 });
    });

    it('acepta encabezados con mayúsculas, tildes y espacios, y precios con coma', () => {
        const { ventas, errores } = ventasDeFilas([{ Canal: 'Tienda física', SKU: 'A1', 'Precio unitario': '1.234,50', 'Descontar stock': 'no', Estado: 'Enviados' }]);
        expect(errores).toEqual([]);
        expect(ventas[0]).toMatchObject({ canal: 'tienda-fisica', estado: 'enviado' });
        expect(ventas[0].lineas[0]).toMatchObject({ precioUnitario: 1234.5, descontarStock: false });
    });

    it('señala cada fila con problema con su número de fila de Excel y sigue con las demás', () => {
        const { ventas, errores } = ventasDeFilas([
            { canal: 'Ripley', precio_unitario: 5 },
            { canal: 'Ripley', sku: 'A', precio_unitario: -1 },
            { canal: 'Ripley', sku: 'A', precio_unitario: 5, cantidad: 1.5 },
            { sku: 'A', precio_unitario: 5 },
            { canal: 'X', sku: 'A', precio_unitario: 5, fecha: '31/02/2026' },
            { canal: 'X', sku: 'A', precio_unitario: 5, estado: 'raro' },
            { canal: 'X', sku: 'A', precio_unitario: 5 },
        ]);
        expect(ventas).toHaveLength(1);
        expect(errores.map(e => e.slice(0, 7))).toEqual(['Fila 2:', 'Fila 3:', 'Fila 4:', 'Fila 5:', 'Fila 6:', 'Fila 7:']);
    });

    it('un producto fuera del catálogo se registra con su nombre', () => {
        const { ventas, errores } = ventasDeFilas([{ canal: 'WhatsApp', producto: 'Cosa suelta', precio_unitario: 20 }]);
        expect(errores).toEqual([]);
        expect(ventas[0].lineas[0]).toMatchObject({ sku: null, producto: 'Cosa suelta' });
    });

    it('fechas: AAAA-MM-DD, día/mes/año y fechas de Excel; vacía = null', () => {
        expect(leerFechaManual('2026-10-25')).toBe('2026-10-25');
        expect(leerFechaManual('05/10/2026')).toBe('2026-10-05');
        expect(leerFechaManual(new Date('2026-10-25T00:00:00Z'))).toBe('2026-10-25');
        expect(leerFechaManual('')).toBeNull();
        expect(leerFechaManual('ayer')).toBe('invalida');
    });

    it('nombres de canal', () => {
        expect(claveDeCanal('  Tienda Física ')).toBe('tienda-fisica');
        expect(nombreDeCanalManual('ripley')).toBe('Ripley');
        expect(nombreDeCanalManual('mi-feria')).toBe('Mi feria');
    });
});

describe('plantilla de ventas', () => {
    it('trae las columnas necesarias, un ejemplo con dos productos en un pedido y las instrucciones, y se puede leer al subirla', async () => {
        const libro = new ExcelJS.Workbook();
        await libro.xlsx.load((await plantillaDeVentas('Mi Tienda')) as any);
        const hoja = libro.getWorksheet('Ventas')!;
        const columnas = (hoja.getRow(1).values as any[]).filter(Boolean);
        expect(columnas).toEqual(expect.arrayContaining(['numero_pedido', 'fecha', 'canal', 'sku', 'cantidad', 'precio_unitario', 'envio', 'estado', 'cliente', 'descontar_stock']));
        expect(libro.getWorksheet('Instrucciones')).toBeDefined();

        const filas: Record<string, any>[] = [];
        for (const n of [2, 3]) {
            const fila: Record<string, any> = {};
            columnas.forEach((c, i) => {
                const v = hoja.getRow(n).getCell(i + 1).value;
                if (v !== null && v !== undefined && v !== '') fila[c] = v;
            });
            filas.push(fila);
        }
        const { ventas, errores } = ventasDeFilas(filas);
        expect(errores).toEqual([]);
        expect(ventas).toHaveLength(1);
        expect(ventas[0].lineas).toHaveLength(2);
    });
});
