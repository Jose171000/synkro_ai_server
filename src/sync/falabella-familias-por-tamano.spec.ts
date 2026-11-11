import { SyncService } from './sync.service';
import { ejesQueSeparanFamilias, sufijoDeFamilia } from './falabella/falabella-fields';

const campo = (name: string, over: any = {}) => ({ name, feedName: name, label: name, isMandatory: true, inputType: 'dropdown', options: [], ...over });
// Una categoría donde solo el color básico es dato de variación (el tamaño de cama es un dato común de la familia).
const SOLO_COLOR = [campo('ColorBasicoVariant', { options: ['Azul', 'Beige', 'Verde', 'Gris'] }), campo('tamano_de_la_cama', { options: ['1,5 plazas', '2 plazas'] })];
const CON_TAMANO = [...SOLO_COLOR, campo('TamanoCamaVariant', { options: ['1,5 plazas', '2 plazas'] })];

const grupo = {
    name: 'Juego de Sábanas Casatex 3000 Hilos Brodery Microfibra', parentSku: 'BE-200-N',
    axes: [{ name: 'Color', values: ['Azul', 'Beige', 'Verde'] }, { name: 'Tamaño cama', values: ['1.5 plazas', '2 plazas'] }],
};

describe('Falabella: una familia por tamaño cuando la categoría no admite el tamaño como variación', () => {
    it('detecta el eje que no admite la categoría y no separa nada si sí lo admite o si el eje no distingue fichas', () => {
        expect(ejesQueSeparanFamilias(grupo.axes, SOLO_COLOR)).toEqual(['Tamaño cama']);
        expect(ejesQueSeparanFamilias(grupo.axes, CON_TAMANO)).toEqual([]);
        expect(ejesQueSeparanFamilias([{ name: 'Tamaño cama', values: ['2 plazas'] }], SOLO_COLOR)).toEqual([]);
        // Una categoría sin campos de variación ni talla y color: cada ficha es suelta, no hay familias que separar.
        expect(ejesQueSeparanFamilias(grupo.axes, [campo('marca')])).toEqual([]);
    });

    it('el sufijo del código padre es corto y sin símbolos', () => {
        expect(sufijoDeFamilia('1.5 plazas')).toBe('15PLAZAS');
        expect(sufijoDeFamilia('2 plazas')).toBe('2PLAZAS');
    });

    const servicio: any = Object.create(SyncService.prototype);
    const ficha = (sku: string, color: string, tam: string) => ({
        sku, name: 'Juego de sábanas', aiTitle: 'Juego de sábanas', price: 265, stock: 3, images: [{ url: 'https://i/1.jpg' }], description: 'Sábanas de microfibra',
        packageWidth: 30, packageLength: 45, packageHeight: 10, packageWeight: 1.1, marketplaceIds: { falabella_category_id: '1272' },
        aiAttributes: { brand: 'Casatex', ColorBasicoVariant: 'Verde', tamano_de_la_cama: '2 plazas', TamanoCamaVariant: '2 plazas' },
        group: grupo, variantValues: { Color: color, 'Tamaño cama': tam },
    });

    it('cada tamaño sale con su propio ParentSku y su propio nombre; los colores de un mismo tamaño comparten ambos', () => {
        const a: any = servicio.toFalabellaInput(ficha('A-15', 'Azul', '1.5 plazas'), 'active', SOLO_COLOR);
        const b: any = servicio.toFalabellaInput(ficha('B-15', 'Beige', '1.5 plazas'), 'active', SOLO_COLOR);
        const c: any = servicio.toFalabellaInput(ficha('A-2', 'Azul', '2 plazas'), 'active', SOLO_COLOR);
        expect(a.input.parentSku).toBe('BE-200-N-15PLAZAS');
        expect(b.input.parentSku).toBe(a.input.parentSku);
        expect(c.input.parentSku).toBe('BE-200-N-2PLAZAS');
        expect(a.input.name).toMatch(/ - 1\.5 plazas$/);
        expect(c.input.name).toMatch(/ - 2 plazas$/);
        expect(b.input.name).toBe(a.input.name);
        // El color de cada ficha sigue siendo el suyo.
        expect(a.input.extraAttributes.ColorBasicoVariant).toBe('Azul');
        expect(b.input.extraAttributes.ColorBasicoVariant).toBe('Beige');
    });

    it('si la categoría admite el tamaño como variación, todas siguen en una sola familia con el nombre común', () => {
        const a: any = servicio.toFalabellaInput(ficha('A-15', 'Azul', '1.5 plazas'), 'active', CON_TAMANO);
        const c: any = servicio.toFalabellaInput(ficha('A-2', 'Azul', '2 plazas'), 'active', CON_TAMANO);
        expect(a.input.parentSku).toBe('BE-200-N');
        expect(c.input.parentSku).toBe('BE-200-N');
        expect(a.input.name).toBe(c.input.name);
        expect(a.input.name).not.toMatch(/plazas/);
    });
});

describe('Falabella: un grupo se publica en UN solo envío', () => {
    const construir = (estados: Record<string, any> = {}) => {
        const s: any = Object.create(SyncService.prototype);
        s.resolveConnection = jest.fn(async () => ({ id: 'c1' }));
        s.listingLinkRepository = { findOne: jest.fn(async ({ where }: any) => estados[where.product.id] ?? null) };
        s.syncQueue = { add: jest.fn(async () => undefined) };
        s.enqueuePublish = jest.fn(async () => ({}));
        s.familiaDe = jest.fn(async () => [1, 2, 3].map((n) => ({ id: `p${n}`, sku: `S${n}`, price: 10 })));
        return s;
    };
    const ambito = { userId: 'u', storeId: 's' };

    it('encola un único trabajo con todas las variantes pendientes, no uno por variante', async () => {
        const s = construir();
        const r = await s.enqueuePublishFamilia(ambito, 'p1', ['falabella'], { falabella: 'c1' });
        expect(s.syncQueue.add).toHaveBeenCalledTimes(1);
        expect(s.syncQueue.add.mock.calls[0][1]).toMatchObject({ marketplace: 'falabella', productIds: ['p1', 'p2', 'p3'], connectionId: 'c1' });
        expect(r.message).toContain('3 de 3');
        expect(s.enqueuePublish).not.toHaveBeenCalled();
    });

    it('salta las ya publicadas o en proceso y, si queda una sola, sale como siempre', async () => {
        const s = construir({ p1: { syncStatus: 'published' }, p2: { syncStatus: 'pending', updatedAt: new Date() } });
        await s.enqueuePublishFamilia(ambito, 'p1', ['falabella'], { falabella: 'c1' });
        expect(s.syncQueue.add).not.toHaveBeenCalled();
        expect(s.enqueuePublish).toHaveBeenCalledWith(ambito, 'p3', ['falabella'], { falabella: 'c1' });
    });

    it('los demás canales siguen publicando variante por variante', async () => {
        const s = construir();
        await s.enqueuePublishFamilia(ambito, 'p1', ['falabella', 'mercadolibre'], { falabella: 'c1', mercadolibre: 'm1' });
        expect(s.syncQueue.add).toHaveBeenCalledTimes(1);
        expect(s.enqueuePublish).toHaveBeenCalledTimes(3);
        expect(s.enqueuePublish.mock.calls[0][2]).toEqual(['mercadolibre']);
    });
});

describe('Mercado Libre: los atributos de lista llevan una opción válida de su lista', () => {
    const construir = (definiciones: any[] | Error) => {
        const s: any = Object.create(SyncService.prototype);
        s.meliApi = { getCategoryAttributes: jest.fn(async () => { if (definiciones instanceof Error) throw definiciones; return definiciones; }) };
        return s;
    };
    const defs = [
        { id: 'MAIN_COLOR', name: 'Color principal', value_type: 'list', values: [{ name: 'Verde' }, { name: 'Azul' }, { name: 'Gris' }] },
        { id: 'MATERIAL', name: 'Material', value_type: 'string', values: [{ name: 'Algodón' }] },
    ];
    const producto = (extra: any = {}) => ({ aiAttributes: {}, ...extra });
    const attrs = [{ id: 'MAIN_COLOR', value_name: 'Verde Olivo' }, { id: 'MATERIAL', value_name: 'Microfibra' }, { id: 'BRAND', value_name: 'Casatex' }];

    it('«Verde Olivo» pasa a «Verde»; lo que no es de lista no se toca', async () => {
        const r = await construir(defs).llevarAListasDeMeli(producto(), 'MPE1', attrs);
        expect(r).toEqual([{ id: 'MAIN_COLOR', value_name: 'Verde' }, { id: 'MATERIAL', value_name: 'Microfibra' }, { id: 'BRAND', value_name: 'Casatex' }]);
    });

    it('el ajuste confirmado por la persona manda sobre la opción más cercana', async () => {
        const p = producto({ aiAttributes: { _ajustes: { mercadolibre: { color: { 'verde olivo': 'Gris' } } } } });
        const r = await construir(defs).llevarAListasDeMeli(p, 'MPE1', attrs);
        expect(r[0]).toEqual({ id: 'MAIN_COLOR', value_name: 'Gris' });
    });

    it('si Mercado Libre no responde, se envía tal cual', async () => {
        const r = await construir(new Error('ML caído')).llevarAListasDeMeli(producto(), 'MPE1', attrs);
        expect(r).toEqual(attrs);
    });
});
