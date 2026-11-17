import { EnlaceDeCanal, MiembroParaPublicar, estadoDeMiembro, evaluarFamilia } from './publicacion-masiva';
import { PublicacionMasivaService, MAX_PUBLICACION_MASIVA } from './publicacion-masiva.service';

const miembro = (id: string, extra: Partial<MiembroParaPublicar> = {}): MiembroParaPublicar => ({ id, sku: `SKU-${id}`, price: 50, fotos: 2, categorias: { falabella: '3223' }, ...extra });
const ahora = Date.parse('2026-11-17T12:00:00Z');
const hace = (min: number) => new Date(ahora - min * 60_000);

describe('estado de un producto en un canal', () => {
    it('lo ya publicado o pausado en esa cuenta no se vuelve a enviar', () => {
        expect(estadoDeMiembro('falabella', miembro('a'), { syncStatus: 'published', updatedAt: hace(500) }, ahora).estado).toBe('publicado');
        expect(estadoDeMiembro('falabella', miembro('a'), { syncStatus: 'paused', updatedAt: hace(500) }, ahora).estado).toBe('publicado');
    });

    it('un envío pendiente reciente está en proceso; uno viejo se puede reintentar', () => {
        expect(estadoDeMiembro('falabella', miembro('a'), { syncStatus: 'pending', updatedAt: hace(3) }, ahora).estado).toBe('en_proceso');
        expect(estadoDeMiembro('falabella', miembro('a'), { syncStatus: 'pending', updatedAt: hace(40) }, ahora).estado).toBe('listo');
    });

    it('con error o quitado se puede volver a enviar', () => {
        expect(estadoDeMiembro('falabella', miembro('a'), { syncStatus: 'error', updatedAt: hace(5) }, ahora).estado).toBe('listo');
        expect(estadoDeMiembro('mercadolibre', miembro('a'), { syncStatus: 'removed', updatedAt: hace(5) }, ahora).estado).toBe('listo');
    });

    it('sin precio o sin fotos no está listo, y dice por qué', () => {
        const r = estadoDeMiembro('mercadolibre', miembro('a', { price: null, fotos: 0 }), undefined, ahora);
        expect(r.estado).toBe('incompleto');
        expect(r.motivos).toEqual(['sin precio', 'sin fotos']);
    });

    it('Falabella exige categoría; Mercado Libre y WooCommerce la eligen solos', () => {
        const sinCat = miembro('a', { categorias: {} });
        expect(estadoDeMiembro('falabella', sinCat, undefined, ahora).motivos[0]).toMatch(/categoría de Falabella/);
        expect(estadoDeMiembro('mercadolibre', sinCat, undefined, ahora).estado).toBe('listo');
        expect(estadoDeMiembro('woocommerce', sinCat, undefined, ahora).estado).toBe('listo');
    });
});

describe('un producto con variantes se publica entero', () => {
    it('si todo está publicado no hay nada que hacer', () => {
        const enlaces = new Map<string, EnlaceDeCanal>([['a', { syncStatus: 'published', updatedAt: hace(9) }], ['b', { syncStatus: 'published', updatedAt: hace(9) }]]);
        expect(evaluarFamilia('falabella', [miembro('a'), miembro('b')], enlaces, ahora).estado).toBe('nada');
    });

    it('cuenta las que faltan y deja pasar las ya publicadas', () => {
        const enlaces = new Map<string, EnlaceDeCanal>([['a', { syncStatus: 'published', updatedAt: hace(9) }]]);
        const r = evaluarFamilia('falabella', [miembro('a'), miembro('b'), miembro('c')], enlaces, ahora);
        expect(r).toMatchObject({ estado: 'listo', publicadas: 1, porPublicar: 2 });
    });

    it('si a una variante pendiente le falta algo, el grupo no se envía en ese canal', () => {
        const r = evaluarFamilia('falabella', [miembro('a'), miembro('b', { fotos: 0 })], new Map(), ahora);
        expect(r.estado).toBe('incompleto');
        expect(r.incompletas).toEqual([{ sku: 'SKU-b', motivos: ['sin fotos'] }]);
    });
});

describe('PublicacionMasivaService', () => {
    const scope = { userId: 'u1', storeId: 's1' };
    const producto = (id: string, extra: any = {}) => ({ id, sku: `S${id}`, name: `Producto ${id}`, price: 10, group: null, images: [{ id: 'i' }], marketplaceIds: { falabella_category_id: '3223' }, aiAttributes: {}, ...extra });

    function armar(opts: { productos: any[]; cuentas: any[]; enlaces?: any[] }) {
        const productos: any = { find: jest.fn(async (q: any) => {
            // La primera consulta trae los elegidos; las siguientes traen fotos/variantes.
            return opts.productos;
        }) };
        const conexiones: any = { find: jest.fn(async () => opts.cuentas) };
        const enlaces: any = { find: jest.fn(async () => opts.enlaces ?? []) };
        const sync: any = { enqueuePublishFamilia: jest.fn(async () => ({ message: 'ok' })) };
        return { servicio: new PublicacionMasivaService(sync, productos, conexiones, enlaces), sync };
    }

    const falabella = { id: 'c-fal', marketplace: 'falabella', label: 'replay', status: 'active' };
    const ripley = { id: 'c-rip', marketplace: 'ripley', label: 'tienda', status: 'active' };

    it('la vista cuenta lo que falta por cuenta y deja a Ripley como no disponible', async () => {
        const { servicio } = armar({ productos: [producto('1'), producto('2')], cuentas: [falabella, ripley] });
        const v = await servicio.vista(scope, ['1', '2']);
        expect(v.cuentas.find((c) => c.id === 'c-fal')).toMatchObject({ soportada: true, faltan: 2, listos: 2 });
        expect(v.cuentas.find((c) => c.id === 'c-rip')).toMatchObject({ soportada: false, faltan: 0 });
    });

    it('publica solo lo listo y salta con motivo lo incompleto o ya publicado', async () => {
        const { servicio, sync } = armar({
            productos: [producto('1'), producto('2', { images: [] }), producto('3')],
            cuentas: [falabella],
            enlaces: [{ product: { id: '3' }, connection: { id: 'c-fal' }, syncStatus: 'published', updatedAt: new Date() }],
        });
        const r = await servicio.publicar(scope, ['1', '2', '3'], ['c-fal']);
        expect(sync.enqueuePublishFamilia).toHaveBeenCalledTimes(1);
        expect(sync.enqueuePublishFamilia).toHaveBeenCalledWith(scope, '1', ['falabella'], { falabella: 'c-fal' });
        expect(r.encoladas).toHaveLength(1);
        expect(r.omitidas.map((o) => o.motivo)).toEqual([expect.stringMatching(/sin fotos/), 'Ya está publicado.']);
    });

    it('un fallo al encolar uno no frena a los demás', async () => {
        const { servicio, sync } = armar({ productos: [producto('1'), producto('2')], cuentas: [falabella] });
        sync.enqueuePublishFamilia.mockRejectedValueOnce(new Error('boom'));
        const r = await servicio.publicar(scope, ['1', '2'], ['c-fal']);
        expect(r.encoladas).toHaveLength(1);
        expect(r.omitidas[0].motivo).toBe('boom');
    });

    it('rechaza Ripley, cuentas ajenas y selecciones vacías', async () => {
        const { servicio } = armar({ productos: [producto('1')], cuentas: [falabella, ripley] });
        await expect(servicio.publicar(scope, ['1'], ['c-rip'])).rejects.toThrow(/piloto/);
        await expect(servicio.publicar(scope, ['1'], ['otra'])).rejects.toThrow(/no está conectada/);
        await expect(servicio.publicar(scope, ['1'], [])).rejects.toThrow(/al menos una cuenta/);
        await expect(servicio.vista(scope, [])).rejects.toThrow(/al menos un producto/);
    });

    it('respeta el tope por tanda', async () => {
        const muchos = Array.from({ length: MAX_PUBLICACION_MASIVA + 1 }, (_, i) => producto(String(i)));
        const { servicio } = armar({ productos: muchos, cuentas: [falabella] });
        await expect(servicio.vista(scope, muchos.map((p) => p.id))).rejects.toThrow(/máximo por tanda/);
    });
});
