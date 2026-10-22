import { categoriasAsignadas, datosQueFaltan, estadoDeCanal } from './completitud';

describe('completitud de un producto', () => {
    const completo = { name: 'Polo', description: 'Polo de algodón', price: 40, stock: 5, images: [{ url: 'https://img/1.jpg' }], marketplaceIds: { falabella_category_id: '123' } };

    it('un producto con foto, precio, stock, descripción y categoría no tiene nada pendiente', () => {
        expect(datosQueFaltan(completo)).toEqual([]);
    });

    it('lista todo lo básico que falta, no solo lo primero', () => {
        expect(datosQueFaltan({ name: 'Polo', description: '  ', price: null, stock: 0, images: [], marketplaceIds: null })).toEqual(['fotos', 'precio', 'descripción', 'categoría']);
    });

    it('stock 0 es un dato válido; solo falta si nunca se indicó', () => {
        expect(datosQueFaltan({ ...completo, stock: 0 })).toEqual([]);
        expect(datosQueFaltan({ ...completo, stock: null })).toEqual(['stock']);
    });

    it('cuenta la categoría de cualquier canal o la interna', () => {
        expect(datosQueFaltan({ ...completo, marketplaceIds: null, aiAttributes: { mercadolibre_category_id: 'MPE1' } })).toEqual([]);
        expect(datosQueFaltan({ ...completo, marketplaceIds: null, category: 'Juguetes' })).toEqual([]);
        expect(categoriasAsignadas({ marketplaceIds: { falabella_category_id: ' ' } })).toEqual({ falabella: null, mercadolibre: null, interna: null });
    });

    it('el estado de un canal refleja la pausa del usuario aunque el canal la muestre activa', () => {
        expect(estadoDeCanal({ marketplace: 'falabella', syncStatus: 'published', pausedByUser: true })).toBe('Pausado');
        expect(estadoDeCanal({ marketplace: 'falabella', syncStatus: 'published' })).toBe('Publicado');
        expect(estadoDeCanal({ marketplace: 'mercadolibre', syncStatus: 'pending' })).toBe('En proceso');
        expect(estadoDeCanal({ marketplace: 'mercadolibre', syncStatus: 'error' })).toBe('Error');
    });
});
