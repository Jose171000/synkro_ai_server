import { ExportService } from './export.service';

const producto = (over: Record<string, any>) => ({ id: 'p', name: 'Producto', sku: 'S1', images: [], stock: 1, price: 10, ...over }) as any;
const exportar = (over: Record<string, any>) => new ExportService({} as any, {} as any).mapProductsForExport([producto(over)])[0];

describe('exportación de productos: ficha HTML', () => {
    it('sale la ficha HTML guardada, sea importada del canal o generada, y aparte la descripción en texto', () => {
        const fila = exportar({ aiDescription: 'Texto plano', aiAttributes: { descriptionHtml: '<p>Ficha</p><ul><li>Uno</li></ul>' } });
        expect(fila.descriptionHtml).toBe('<p>Ficha</p><ul><li>Uno</li></ul>');
        expect(fila.descriptionText).toBe('Texto plano');
    });

    it('sin ficha guardada, una descripción que ya viene en HTML cuenta como ficha', () => {
        expect(exportar({ description: '<p>Del canal</p>', aiAttributes: {} }).descriptionHtml).toBe('<p>Del canal</p>');
    });

    it('sin ficha ni HTML la columna queda vacía (el texto plano no se hace pasar por ficha)', () => {
        const fila = exportar({ aiDescription: 'Solo texto', description: 'a < b' });
        expect(fila.descriptionHtml).toBe('');
        expect(fila.descriptionText).toBe('Solo texto');
    });
});
