import * as ExcelJS from 'exceljs';
import { FichasPorCanalService, nombreDeHoja } from './fichas-por-canal.service';

const producto = (over: Record<string, any>) => ({ id: 'p', name: 'Producto', sku: 'S1', stock: 2, price: 10, aiAttributes: {}, marketplaceIds: {}, ...over }) as any;

function servicio(falabellaPropio?: any) {
    const sync: any = {
        categoriaFalabella: (p: any) => p.marketplaceIds?.falabella_category_id,
        credentialsOf: () => ({ userId: 'u', apiKey: 'k' }),
        buscarAtributo: (a: any, n: string) => a[n],
        atributosParaMeli: () => [],
    };
    const falabella: any = falabellaPropio ?? {
        getCategories: async () => [{ id: '10', path: 'Salud › Vitaminas' }, { id: '20', path: 'Hogar › Ollas' }],
        getCategoryAttributes: async (_c: any, id: string) => id === '10'
            ? [{ name: 'Registro', label: 'Registro sanitario', isMandatory: true }, { name: 'Chino', label: 'Nombre en chino', isMandatory: false }]
            : [{ name: 'Material', label: 'Material', isMandatory: false }],
    };
    return new FichasPorCanalService(sync, falabella, {} as any, {} as any, { findOne: async () => ({ accessToken: 'k' }) } as any);
}

async function leer(buffer: Buffer) {
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(buffer as any);
    return libro.worksheets.map((h) => ({
        nombre: h.name,
        filas: Array.from({ length: h.rowCount }, (_, i) => Array.from({ length: h.columnCount }, (__, c) => h.getRow(i + 1).getCell(c + 1).value ?? '')),
    }));
}

describe('fichas por canal', () => {
    it('una hoja por categoría, con sus propios campos (también los vacíos) y los obligatorios marcados', async () => {
        const productos = [
            producto({ id: 'a', sku: 'A', marketplaceIds: { falabella_category_id: '10' }, aiAttributes: { brand: 'JOY', Registro: 'DE-1' } }),
            producto({ id: 'b', sku: 'B', marketplaceIds: { falabella_category_id: '20' }, aiAttributes: { Material: 'Acero' } }),
            producto({ id: 'c', sku: 'C' }),
        ];
        const hojas = await leer(await servicio().generar('t', productos, new Map(), 'falabella'));

        expect(hojas.map((h) => h.nombre)).toEqual(['Índice', 'Falabella · Vitaminas', 'Falabella · Ollas']);
        const [titulos, fila] = hojas[1].filas;
        expect(titulos.slice(-2)).toEqual(['Registro sanitario *', 'Nombre en chino']);
        expect(fila[titulos.indexOf('Registro sanitario *')]).toBe('DE-1');
        expect(fila[titulos.indexOf('Marca')]).toBe('JOY');
        expect(hojas[2].filas[0]).not.toContain('Registro sanitario *');
        // El que no tiene nada de Falabella no sale en ninguna hoja y el índice lo dice.
        expect(JSON.stringify(hojas[0].filas)).toContain('no salen en ninguna hoja');
    });

    it('si el canal no responde, la hoja sale con lo guardado y lo avisa', async () => {
        const falabella = { getCategories: async () => [], getCategoryAttributes: async () => { throw new Error('429'); } };
        const hojas = await leer(await servicio(falabella).generar('t', [
            producto({ marketplaceIds: { falabella_category_id: '10' }, aiAttributes: { Registro: 'DE-1', _interno: 'x', descriptionHtml: '<p>x</p>' } }),
        ], new Map(), 'falabella'));

        expect(hojas[1].filas[0]).toContain('Registro');
        expect(hojas[1].filas[0]).not.toContain('_interno');
        expect(hojas[1].filas[0]).not.toContain('descriptionHtml');
        expect(JSON.stringify(hojas[0].filas)).toContain('No se pudo pedir la lista de campos');
    });

    it('los nombres de hoja caben en Excel y no se repiten', () => {
        const usados = new Set<string>();
        const largo = 'Falabella · Otros cuidados para la dieta/salud';
        const primero = nombreDeHoja(largo, usados);
        const segundo = nombreDeHoja(largo, usados);
        expect(primero.length).toBeLessThanOrEqual(31);
        expect(segundo.length).toBeLessThanOrEqual(31);
        expect(segundo).not.toBe(primero);
        expect(primero).not.toContain('/');
    });
});
