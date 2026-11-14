import { WooCategoriasService } from './woo-categorias.service';

const lista = [
    { id: 2, name: 'Hogar', parent: 0, count: 10, slug: 'hogar' },
    { id: 4, name: 'Sábanas', parent: 2, count: 6, slug: 'sabanas' },
    { id: 6, name: 'Accesories', parent: 0, count: 30, slug: 'accesories' },
];

const producto = (sobre: any = {}) => ({ id: 'p1', name: 'Juego de Sábanas Casatex', aiTitle: null, description: 'desc', images: [{ url: 'https://c.com/1.jpg' }], aiAttributes: {}, ...sobre });

function armar(opciones: { ia?: any; enlaces?: any[] } = {}) {
    const productos: any = { update: jest.fn(async () => undefined) };
    const enlaces: any = { find: jest.fn(async () => opciones.enlaces ?? []) };
    const api: any = { listarCategorias: jest.fn(async () => lista), actualizarProducto: jest.fn(async () => undefined) };
    const sync: any = {
        getValidConnectionById: jest.fn(async () => ({ id: 'c1' })),
        resolveConnection: jest.fn(async () => ({ id: 'c1' })),
        familiaDe: jest.fn(async () => [producto()]),
        categoriaWooConIA: opciones.ia,
    };
    const ecommerce: any = { authOf: jest.fn(() => ({ site: 'https://t.com', token: 'k' })) };
    return { servicio: new WooCategoriasService(productos, enlaces, api, sync, ecommerce), productos, api, sync };
}

describe('WooCategoriasService', () => {
    it('por texto: elige la categoría de la tienda y la guarda en el producto', async () => {
        const { servicio, productos } = armar();
        const r = await servicio.elegir([producto() as any], 'c1');
        expect(r).toMatchObject({ origen: 'texto', categoria: { id: 4, ruta: 'Hogar › Sábanas' } });
        expect(productos.update).toHaveBeenCalledWith('p1', { aiAttributes: { _wooCategorias: { c1: { id: 4, ruta: 'Hogar › Sábanas', origen: 'texto' } } } });
    });

    it('reutiliza la categoría ya guardada (sin consultar a la IA) mientras exista en la tienda', async () => {
        const ia = jest.fn();
        const { servicio } = armar({ ia });
        const p = producto({ name: 'Algo raro', aiAttributes: { _wooCategorias: { c1: { id: 6, origen: 'manual' } } } });
        expect(await servicio.elegir([p as any], 'c1')).toMatchObject({ origen: 'manual', categoria: { id: 6 } });
        expect(ia).not.toHaveBeenCalled();
    });

    it('si la guardada ya no existe en la tienda, elige de nuevo', async () => {
        const { servicio } = armar();
        const p = producto({ aiAttributes: { _wooCategorias: { c1: { id: 999, origen: 'texto' } } } });
        expect((await servicio.elegir([p as any], 'c1'))?.categoria.id).toBe(4);
    });

    it('sin coincidencia de texto decide la IA, con nombre, descripción y foto, y solo entre las de la tienda', async () => {
        const ia = jest.fn(async () => ({ id: 4, motivo: 'son sábanas' }));
        const { servicio } = armar({ ia });
        const r = await servicio.elegir([producto({ name: 'Juego de lencería para cama' }) as any], 'c1');
        expect(r).toMatchObject({ origen: 'ia', motivo: 'son sábanas', categoria: { id: 4 } });
        expect(ia).toHaveBeenCalledWith(expect.objectContaining({ imagen: 'https://c.com/1.jpg', categorias: [{ id: 6, ruta: 'Accesories' }, { id: 2, ruta: 'Hogar' }, { id: 4, ruta: 'Hogar › Sábanas' }] }));
    });

    it('si la IA devuelve una categoría que no existe, no se elige ninguna', async () => {
        const { servicio, productos } = armar({ ia: jest.fn(async () => ({ id: 12345, motivo: '' })) });
        expect(await servicio.elegir([producto({ name: 'Cosa rara' }) as any], 'c1')).toBeNull();
        expect(productos.update).not.toHaveBeenCalled();
    });

    it('sin IA disponible y sin coincidencia, devuelve null', async () => {
        const { servicio } = armar();
        expect(await servicio.elegir([producto({ name: 'Cosa rara' }) as any], 'c1')).toBeNull();
    });

    it('fijar a mano guarda la categoría y la cambia también en WooCommerce, solo la categoría', async () => {
        const { servicio, api } = armar({ enlaces: [{ externalId: '31778' }, { externalId: '31778' }] });
        const r = await servicio.fijar({ userId: 'u', storeId: 's' } as any, 'p1', undefined, 6);
        expect(r).toMatchObject({ origen: 'manual', categoria: { id: 6 }, actualizadosEnWoo: 1 });
        expect(api.actualizarProducto).toHaveBeenCalledTimes(1);
        expect(api.actualizarProducto).toHaveBeenCalledWith(expect.anything(), '31778', { categories: [{ id: 6 }] });
    });

    it('fijar una categoría que no existe en la tienda se rechaza', async () => {
        const { servicio, api } = armar();
        await expect(servicio.fijar({ userId: 'u', storeId: 's' } as any, 'p1', undefined, 999)).rejects.toThrow(/no existe/);
        expect(api.actualizarProducto).not.toHaveBeenCalled();
    });

    it('fijar sin categoría vuelve a elegir sola, ignorando la guardada', async () => {
        const { servicio, sync } = armar();
        sync.familiaDe.mockResolvedValue([producto({ aiAttributes: { _wooCategorias: { c1: { id: 6, origen: 'texto' } } } })]);
        expect((await servicio.fijar({ userId: 'u', storeId: 's' } as any, 'p1', undefined))?.categoria.id).toBe(4);
    });
});
