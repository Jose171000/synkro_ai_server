import { candidatasParaIA, categoriaPorId, elegirPorTexto, palabrasDe, rutasDeCategorias } from './woo-categorias';

const tienda = rutasDeCategorias([
    { id: 1, name: 'Uncategorized', parent: 0, slug: 'uncategorized', count: 50 },
    { id: 2, name: 'Hogar &amp; Decoración', parent: 0, count: 10 },
    { id: 3, name: 'Cama', parent: 2, count: 8 },
    { id: 4, name: 'Sábanas', parent: 3, count: 6 },
    { id: 5, name: 'Edredones', parent: 3, count: 4 },
    { id: 6, name: 'Accesories', parent: 0, count: 30 },
    { id: 7, name: 'Bebé', parent: 0, count: 3 },
    { id: 8, name: 'Sábanas', parent: 7, count: 1 },
]);

describe('woo-categorias · rutas', () => {
    it('arma la ruta completa, decodifica el texto y no ofrece la categoría por defecto de WordPress', () => {
        expect(tienda.find((c) => c.id === 4)).toMatchObject({ ruta: 'Hogar & Decoración › Cama › Sábanas', profundidad: 3 });
        expect(tienda.some((c) => c.id === 1)).toBe(false);
    });
    it('las palabras se comparan sin tildes y en singular', () => {
        expect(palabrasDe('Sábanas')).toEqual(palabrasDe('sabana'));
        expect(palabrasDe('Ropa de cama')).toEqual(['ropa', 'cama']);
    });
});

describe('woo-categorias · tiendas con muchas categorías', () => {
    const muchas = rutasDeCategorias([
        { id: 1, name: 'Hogar', parent: 0, count: 5 },
        { id: 2, name: 'Sábanas', parent: 1, count: 2 },
        ...Array.from({ length: 600 }, (_, i) => ({ id: 100 + i, name: `Categoría ${i}`, parent: 0, count: i % 7 })),
    ]);

    it('con pocas categorías se manda toda la lista a la IA', () => {
        expect(candidatasParaIA({ titulo: 'x' }, tienda, 150)).toHaveLength(tienda.length);
    });

    it('con cientos, solo las parecidas al producto (primero) y nunca más del tope', () => {
        const r = candidatasParaIA({ titulo: 'Juego de sábanas bordadas', descripcion: 'para cama' }, muchas, 50);
        expect(r).toHaveLength(50);
        expect(r[0].nombre).toBe('Sábanas');
        expect(r.every((c) => muchas.includes(c))).toBe(true);
    });

    it('una categoría cuyo padre coincide también cuenta, pero menos que la propia', () => {
        const r = candidatasParaIA({ titulo: 'artículos de hogar' }, muchas, 50);
        expect(r[0].nombre).toBe('Hogar');
        expect(r[1].nombre).toBe('Sábanas');
    });

    it('sin ninguna parecida manda las más usadas', () => {
        const r = candidatasParaIA({ titulo: 'zzz' }, muchas, 20);
        expect(r).toHaveLength(20);
        expect(Math.min(...r.map((c) => c.cantidad))).toBeGreaterThanOrEqual(5);
    });
});

describe('woo-categorias · elegir por texto', () => {
    it('usa la subcategoría o la categoría escrita en el producto, si existe en la tienda', () => {
        expect(elegirPorTexto({ categoria: 'Hogar & Decoración', subcategoria: 'Edredones', titulo: 'x' }, tienda)?.id).toBe(5);
        expect(elegirPorTexto({ categoria: 'Hogar & Decoración', subcategoria: 'No existe', titulo: 'x' }, tienda)?.id).toBe(2);
    });

    it('encuentra la categoría cuyo nombre está en el título', () => {
        expect(elegirPorTexto({ titulo: 'Edredón Acolchado + Juego de Edredones 2 plazas' }, tienda)?.id).toBe(5);
    });

    it('una categoría de varias palabras debe estar completa en el título', () => {
        const lista = rutasDeCategorias([{ id: 1, name: 'Ropa de cama', parent: 0 }, { id: 2, name: 'Cama', parent: 0 }]);
        expect(elegirPorTexto({ titulo: 'Cama inflable' }, lista)?.id).toBe(2);
        expect(elegirPorTexto({ titulo: 'Ropa de cama premium' }, lista)?.id).toBe(1);
    });

    it('si el mismo nombre está en dos ramas distintas no decide (lo hace la IA)', () => {
        expect(elegirPorTexto({ titulo: 'Juego de Sábanas Casatex 3000 Hilos' }, tienda)).toBeNull();
    });

    it('si nada del título coincide devuelve null y nunca elige una categoría por azar', () => {
        expect(elegirPorTexto({ titulo: 'Lámpara de mesa' }, tienda)).toBeNull();
        expect(elegirPorTexto({ titulo: '' }, tienda)).toBeNull();
        expect(elegirPorTexto({ titulo: 'Sábanas' }, [])).toBeNull();
    });

    it('la IA solo puede elegir una categoría que exista', () => {
        expect(categoriaPorId(4, tienda)?.nombre).toBe('Sábanas');
        expect(categoriaPorId(999, tienda)).toBeNull();
    });
});
