import { ProductOverviewService } from './product-overview.service';

/**
 * Lo que la lista de productos muestra de cada uno. Se protege que la categoría y el estado sean los reales del canal
 * (no la intención), que lo que falta para Falabella salga completo, y que una pausa o un retiro se vean como tales.
 */
const base = { id: 'p1', sku: 'S-1', name: 'Globo', description: 'Globo terráqueo infantil', price: 76.9, stock: 50, images: [{ url: 'https://img/1.jpg' }], targetMarketplaces: ['falabella'], marketplaceIds: null as any, aiAttributes: {} as any };

function construir(productos: any[], enlaces: any[], opciones: { atributos?: any[]; reason?: string; sinCuenta?: boolean } = {}) {
    const productRepo: any = { find: jest.fn(async () => productos) };
    const linkRepo: any = { find: jest.fn(async () => enlaces) };
    const sync: any = {
        resolveConnection: jest.fn(async () => { if (opciones.sinCuenta) throw new Error('sin cuenta'); return { id: 'c1' }; }),
        credentialsOf: jest.fn(() => ({ userId: 'u' })),
        toFalabellaInput: jest.fn(() => (opciones.reason ? { reason: opciones.reason } : { input: {} })),
    };
    const falabella: any = {
        getCategories: jest.fn(async () => [{ id: '123', path: 'Juguetes › Educativos' }]),
        getCategoryAttributes: jest.fn(async () => opciones.atributos ?? []),
    };
    return { servicio: new ProductOverviewService(productRepo, linkRepo, sync, falabella), sync, falabella };
}

const ambito = { userId: 'u1', storeId: 's1' };

describe('ProductOverviewService', () => {
    it('sin categoría ni medidas lo dice claro y no consulta atributos', async () => {
        const { servicio, falabella } = construir([{ ...base }], []);
        const r = (await servicio.obtener(ambito, ['p1'])).p1;
        expect(r.completeness.ready).toBe(false);
        expect(r.completeness.missing).toContain('categoría');
        expect(r.completeness.byChannel.falabella.missing).toEqual(['categoría de Falabella', 'medidas y peso del paquete']);
        expect(falabella.getCategoryAttributes).not.toHaveBeenCalled();
    });

    it('con categoría y medidas lista cada dato obligatorio que falta de la categoría', async () => {
        const p = { ...base, marketplaceIds: { falabella_category_id: '123' }, packageWidth: 20, packageLength: 20, packageHeight: 20, packageWeight: 1 };
        const { servicio } = construir([p], [], { reason: 'le faltan datos que pide su categoria en Falabella: Material, Edad recomendada' });
        const r = (await servicio.obtener(ambito, ['p1'])).p1;
        expect(r.categories.falabella).toEqual({ id: '123', path: 'Juguetes › Educativos' });
        expect(r.completeness.byChannel.falabella).toEqual({ ready: false, missing: ['Material', 'Edad recomendada'] });
        expect(r.completeness.ready).toBe(false);
    });

    it('un producto con todo está listo', async () => {
        const p = { ...base, marketplaceIds: { falabella_category_id: '123' }, packageWidth: 20, packageLength: 20, packageHeight: 20, packageWeight: 1 };
        const { servicio } = construir([p], []);
        const r = (await servicio.obtener(ambito, ['p1'])).p1;
        expect(r.completeness).toEqual({ ready: true, missing: [], byChannel: { falabella: { ready: true, missing: [] } } });
    });

    it('muestra el estado real de cada canal: pausa del usuario y error con su motivo; oculta lo retirado', async () => {
        const enlaces = [
            { id: 'l1', marketplace: 'falabella', syncStatus: 'published', pausedByUser: true, lastError: null, permalink: 'https://f', connection: { label: 'Maba' }, product: { id: 'p1' } },
            { id: 'l2', marketplace: 'mercadolibre', syncStatus: 'error', pausedByUser: false, lastError: 'cuenta restringida', permalink: null, connection: { externalNickname: 'MABA' }, product: { id: 'p1' } },
            { id: 'l3', marketplace: 'shopify', syncStatus: 'removed', pausedByUser: false, lastError: null, permalink: null, connection: null, product: { id: 'p1' } },
        ];
        const { servicio } = construir([{ ...base, targetMarketplaces: [] }], enlaces);
        const r = (await servicio.obtener(ambito, ['p1'])).p1;
        expect(r.channels.map((c) => [c.marketplace, c.account, c.status, c.statusLabel, c.error])).toEqual([
            ['falabella', 'Maba', 'paused', 'Pausado', null],
            ['mercadolibre', 'MABA', 'error', 'Error', 'cuenta restringida'],
        ]);
    });

    it('sin cuenta de Falabella conectada no falla: avisa lo que se sabe sin consultar atributos', async () => {
        const p = { ...base, marketplaceIds: { falabella_category_id: '123' }, packageWidth: 20, packageLength: 20, packageHeight: 20, packageWeight: 1 };
        const { servicio, falabella } = construir([p], [], { sinCuenta: true });
        const r = (await servicio.obtener(ambito, ['p1'])).p1;
        expect(r.categories.falabella).toEqual({ id: '123', path: null });
        expect(falabella.getCategoryAttributes).not.toHaveBeenCalled();
        expect(r.completeness.byChannel.falabella.ready).toBe(true);
    });

    it('ignora ids repetidos o vacíos y no pasa de 100', async () => {
        const { servicio } = construir([{ ...base }], []);
        expect(await servicio.obtener(ambito, [])).toEqual({});
        expect(Object.keys(await servicio.obtener(ambito, ['p1', 'p1', '']))).toEqual(['p1']);
    });
});
