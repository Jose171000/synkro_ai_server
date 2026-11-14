import { WooPublicacionService } from './woo-publicacion.service';
import { PlanInvalido } from './woo-plan';

const grupo = { id: 'g1', name: 'Sábanas', parentSku: 'SAB', axes: [{ name: 'Color', values: ['Rojo', 'Azul'] }] };
const variante = (n: number, color: string, sobre: any = {}) => ({
    id: `p${n}`, sku: `S-${n}`, name: 'Sábana', price: 100, stock: 4, images: [{ url: `https://c.com/${n}.jpg` }], group: grupo, variantValues: { Color: color }, ...sobre,
});

function armar(opciones: { familia: any[]; enlaces?: any[]; variacionesExistentes?: { id: string; sku: string }[]; crear?: any } = { familia: [] }) {
    const enlacesGuardados = new Map<string, any>();
    for (const e of opciones.enlaces ?? []) enlacesGuardados.set(e.product.id, e);
    const productos: any = {
        findOne: jest.fn(async ({ where }: any) => opciones.familia.find((p) => p.id === where.id) ?? null),
        find: jest.fn(async () => opciones.familia),
    };
    const enlaces: any = {
        findOne: jest.fn(async ({ where }: any) => enlacesGuardados.get(where.product.id) ?? null),
        create: jest.fn((x: any) => ({ ...x })),
        save: jest.fn(async (x: any) => { enlacesGuardados.set(x.product.id, x); return x; }),
    };
    const api: any = {
        crearProducto: jest.fn(async () => ({ id: '900', permalink: 'https://t.com/?p=900' })),
        actualizarProducto: jest.fn(async () => ({ permalink: 'https://t.com/sabanas-casatex/' })),
        variacionesDe: jest.fn(async () => opciones.variacionesExistentes ?? []),
        crearVariaciones: opciones.crear ?? jest.fn(async (_a: any, _id: string, cuerpos: any[]) => cuerpos.map((_, i) => ({ id: String(500 + i), error: null }))),
    };
    const sync: any = { getValidConnectionById: jest.fn(async () => ({ id: 'c1' })) };
    const ecommerce: any = { authOf: jest.fn(() => ({ site: 'https://t.com', token: 'k', secret: 's' })) };
    const notificaciones: any = { notify: jest.fn(async () => undefined) };
    const categorias: any = { elegir: jest.fn(async () => ({ categoria: { id: 7, nombre: 'Sábanas', ruta: 'Hogar › Sábanas' }, origen: 'texto' })) };
    const servicio = new WooPublicacionService(productos, enlaces, api, sync, ecommerce, categorias, notificaciones);
    return { servicio, api, enlacesGuardados, notificaciones, categorias };
}

afterEach(() => { delete process.env.WOO_PUBLICAR_COMO_BORRADOR; });

describe('WooPublicacionService', () => {
    it('un producto suelto se crea oculto, se le ponen las fotos y al final se publica y se enlaza como publicado', async () => {
        const p = variante(1, 'Rojo', { group: null, variantValues: null, category: 'Hogar', subCategory: 'Cama' });
        const { servicio, api, enlacesGuardados, notificaciones } = armar({ familia: [p] });
        const r = await servicio.publish('p1', 'u1', 'c1');
        expect(r).toEqual({ externalId: '900', creadas: 1, publicado: true });
        const cuerpo = api.crearProducto.mock.calls[0][1];
        expect(cuerpo).toMatchObject({ type: 'simple', status: 'draft', sku: 'S-1', categories: [{ id: 7 }] });
        expect(cuerpo.images).toBeUndefined(); // las fotos van aparte para que un reintento no duplique el producto
        expect(api.actualizarProducto).toHaveBeenNthCalledWith(1, expect.anything(), '900', { images: [{ src: 'https://c.com/1.jpg' }] });
        expect(api.actualizarProducto).toHaveBeenNthCalledWith(2, expect.anything(), '900', { status: 'publish' });
        expect(enlacesGuardados.get('p1')).toMatchObject({ marketplace: 'woocommerce', externalId: '900', variationId: null, syncStatus: 'published', permalink: 'https://t.com/sabanas-casatex/', regularPrice: 100 });
        expect(notificaciones.notify).toHaveBeenCalledWith('u1', expect.objectContaining({ type: 'publish', marketplace: 'woocommerce', title: expect.stringContaining('ya está publicado') }));
    });

    it('con WOO_PUBLICAR_COMO_BORRADOR=true se queda en borrador: no se publica y el enlace queda «pausado»', async () => {
        process.env.WOO_PUBLICAR_COMO_BORRADOR = 'true';
        const { servicio, api, enlacesGuardados, notificaciones } = armar({ familia: [variante(1, 'Rojo', { group: null, variantValues: null })] });
        const r = await servicio.publish('p1', 'u1', 'c1');
        expect(r.publicado).toBe(false);
        expect(api.actualizarProducto).not.toHaveBeenCalledWith(expect.anything(), '900', { status: 'publish' });
        expect(enlacesGuardados.get('p1')).toMatchObject({ syncStatus: 'paused' });
        expect(notificaciones.notify.mock.calls[0][1].title).toContain('borrador');
    });

    it('en un grupo se publica solo después de crear todas las variaciones', async () => {
        const orden: string[] = [];
        const familia = [variante(1, 'Rojo'), variante(2, 'Azul')];
        const crear = jest.fn(async (_a: any, _id: string, cuerpos: any[]) => { orden.push('variaciones'); return cuerpos.map((_, i) => ({ id: String(500 + i), error: null })); });
        const { servicio, api, enlacesGuardados } = armar({ familia, crear });
        api.actualizarProducto.mockImplementation(async (_a: any, _id: string, cuerpo: any) => { orden.push(cuerpo.status === 'publish' ? 'publicar' : 'fotos'); return { permalink: 'https://t.com/p/' }; });
        await servicio.publish('p1', 'u1', 'c1');
        expect(orden).toEqual(['fotos', 'variaciones', 'publicar']);
        expect(enlacesGuardados.get('p1')).toMatchObject({ syncStatus: 'published', variationId: '500' });
        expect(enlacesGuardados.get('p2')).toMatchObject({ syncStatus: 'published', variationId: '501' });
    });

    it('un grupo crea UN producto variable y una variación por variante, cada una enlazada con su id', async () => {
        const familia = [variante(1, 'Rojo'), variante(2, 'Azul')];
        const { servicio, api, enlacesGuardados } = armar({ familia });
        const r = await servicio.publish('p1', 'u1', 'c1');
        expect(api.crearProducto).toHaveBeenCalledTimes(1);
        expect(api.crearProducto.mock.calls[0][1]).toMatchObject({ type: 'variable', status: 'draft', name: 'Sábanas' });
        expect(api.crearVariaciones.mock.calls[0][1]).toBe('900');
        expect(api.crearVariaciones.mock.calls[0][2].map((c: any) => c.sku)).toEqual(['S-1', 'S-2']);
        expect(r.creadas).toBe(2);
        expect(enlacesGuardados.get('p1')).toMatchObject({ externalId: '900', variationId: '500', variation: 'Rojo', parentSku: 'SAB' });
        expect(enlacesGuardados.get('p2')).toMatchObject({ externalId: '900', variationId: '501', variation: 'Azul' });
    });

    it('un reintento reutiliza el producto ya creado y solo crea las variaciones que faltan', async () => {
        const familia = [variante(1, 'Rojo'), variante(2, 'Azul')];
        const previo = { product: familia[0], externalId: '900', variationId: '500', syncStatus: 'paused', marketplace: 'woocommerce' };
        const { servicio, api, enlacesGuardados } = armar({ familia, enlaces: [previo, { ...previo, product: familia[1], variationId: null }], variacionesExistentes: [{ id: '500', sku: 'S-1' }] });
        const r = await servicio.publish('p1', 'u1', 'c1');
        expect(api.crearProducto).not.toHaveBeenCalled();
        expect(api.crearVariaciones.mock.calls[0][2].map((c: any) => c.sku)).toEqual(['S-2']);
        expect(r.creadas).toBe(2);
        expect(enlacesGuardados.get('p1').variationId).toBe('500');
        expect(enlacesGuardados.get('p2').variationId).toBe('500'); // la nueva recibe el id devuelto en esta corrida
    });

    it('si WooCommerce rechaza una variación, la marca con su motivo y falla para que la cola reintente', async () => {
        const familia = [variante(1, 'Rojo'), variante(2, 'Azul')];
        const crear = jest.fn(async () => [{ id: '500', error: null }, { id: null, error: 'El SKU ya existe' }]);
        const { servicio, api, enlacesGuardados } = armar({ familia, crear });
        await expect(servicio.publish('p1', 'u1', 'c1')).rejects.toThrow(/1 variante.*El SKU ya existe/);
        expect(enlacesGuardados.get('p1')).toMatchObject({ variationId: '500', syncStatus: 'paused' });
        expect(enlacesGuardados.get('p2')).toMatchObject({ syncStatus: 'error', lastError: 'El SKU ya existe' });
        // Con una variación sin crear, el producto NO se publica: nunca queda a la venta a medias.
        expect(api.actualizarProducto).not.toHaveBeenCalledWith(expect.anything(), '900', { status: 'publish' });
    });

    it('sin precio falla con PlanInvalido antes de llamar a la tienda', async () => {
        const { servicio, api } = armar({ familia: [variante(1, 'Rojo', { price: null, group: null, variantValues: null })] });
        await expect(servicio.publish('p1', 'u1', 'c1')).rejects.toBeInstanceOf(PlanInvalido);
        expect(api.crearProducto).not.toHaveBeenCalled();
    });

    it('la categoría elegida entre las de la tienda va en el producto y en el aviso', async () => {
        const { servicio, api, notificaciones, categorias } = armar({ familia: [variante(1, 'Rojo', { group: null, variantValues: null })] });
        await servicio.publish('p1', 'u1', 'c1');
        expect(categorias.elegir).toHaveBeenCalledWith(expect.any(Array), 'c1');
        expect(api.crearProducto.mock.calls[0][1].categories).toEqual([{ id: 7 }]);
        expect(notificaciones.notify.mock.calls[0][1].body).toContain('Categoría: Hogar › Sábanas');
    });

    it('un producto que ya está a la venta no vuelve a «pausado» mientras se completan sus variaciones', async () => {
        const familia = [variante(1, 'Rojo'), variante(2, 'Azul')];
        const vivo = (p: any, variationId: string | null) => ({ product: p, externalId: '900', variationId, syncStatus: 'published', marketplace: 'woocommerce' });
        const { servicio, enlacesGuardados } = armar({ familia, enlaces: [vivo(familia[0], '500'), vivo(familia[1], null)], variacionesExistentes: [{ id: '500', sku: 'S-1' }] });
        await servicio.publish('p1', 'u1', 'c1');
        expect(enlacesGuardados.get('p1').syncStatus).toBe('published');
        expect(enlacesGuardados.get('p2').syncStatus).toBe('published');
    });

    it('si ninguna categoría de la tienda encaja (o falla), el producto se crea igual y se avisa', async () => {
        const { servicio, api, notificaciones, categorias } = armar({ familia: [variante(1, 'Rojo', { group: null, variantValues: null })] });
        categorias.elegir.mockRejectedValueOnce(new Error('sin permiso'));
        await servicio.publish('p1', 'u1', 'c1');
        expect(api.crearProducto.mock.calls[0][1].categories).toBeUndefined();
        expect(notificaciones.notify.mock.calls[0][1].body).toContain('No se encontró una categoría');
    });
});
