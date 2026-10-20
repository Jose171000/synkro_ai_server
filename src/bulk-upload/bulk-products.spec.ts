import { esJpg, fotosDeCarpeta, leerFecha, leerPrecio, leerStock, partirLista } from './bulk-products';

describe('plantilla de carga masiva de productos', () => {
    it('lee el precio escrito de varias formas', () => {
        expect(leerPrecio('250')).toBe(250);
        expect(leerPrecio('S/ 1,250.50')).toBe(1250.5);
        expect(leerPrecio('1.250,50')).toBe(1250.5);
        expect(leerPrecio('89,9')).toBe(89.9);
        expect(leerPrecio('1,250')).toBe(1250);
        expect(leerPrecio('')).toBeNull();
        expect(leerPrecio('0')).toBeNull();
        expect(leerPrecio('gratis')).toBeNull();
    });

    it('el stock vacío es 0 y los valores raros se rechazan', () => {
        expect(leerStock('')).toBe(0);
        expect(leerStock('12')).toBe(12);
        expect(leerStock('12.0')).toBe(12);
        expect(leerStock('-3')).toBeNull();
        expect(leerStock('mucho')).toBeNull();
    });

    it('solo acepta JPG, también en direcciones web con parámetros', () => {
        expect(esJpg('fotos/a.JPG')).toBe(true);
        expect(esJpg('a.jpeg')).toBe(true);
        expect(esJpg('https://x.com/a.jpg?v=2')).toBe(true);
        expect(esJpg('a.png')).toBe(false);
        expect(esJpg('a.webp')).toBe(false);
    });

    it('parte la lista de fotos por comas, punto y coma o saltos de línea', () => {
        expect(partirLista('a.jpg, b.jpg;c.jpg\nd.jpg')).toEqual(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
        expect(partirLista('')).toEqual([]);
    });

    it('busca en el ZIP las fotos de un SKU por carpeta o por nombre, en orden', () => {
        const zip = [
            'fotos/mk-001.jpg', 'fotos/mk-001-2.jpg', 'fotos/mk-001-10.jpg',
            'fotos/mk-002.jpg', 'mk-003/principal.jpg', 'mk-003/2.jpg', 'mk-003/nota.txt', 'fotos/mk-001.png',
        ];
        expect(fotosDeCarpeta('MK-001', zip)).toEqual(['fotos/mk-001-2.jpg', 'fotos/mk-001-10.jpg', 'fotos/mk-001.jpg'].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
        expect(fotosDeCarpeta('MK-003', zip)).toEqual(['mk-003/2.jpg', 'mk-003/principal.jpg']);
        expect(fotosDeCarpeta('MK-004', zip)).toEqual([]);
    });

    it('no confunde la foto de otro SKU que empieza igual', () => {
        const zip = ['mk-001.jpg', 'mk-001-2.jpg'];
        expect(fotosDeCarpeta('MK-001', zip, new Set(['mk-001', 'mk-001-2']))).toEqual(['mk-001.jpg']);
    });

    it('lee las fechas del descuento escritas de varias formas', () => {
        expect(leerFecha('2026-11-30')).toBe('2026-11-30');
        expect(leerFecha('2026-1-5')).toBe('2026-01-05');
        expect(leerFecha('30/11/2026')).toBe('2026-11-30');
        expect(leerFecha('')).toBeNull();
        expect(leerFecha('pronto')).toBeUndefined();
    });
});
