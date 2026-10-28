import { sugerirVinculos, CandidatoSynkro } from './yavendio-matching';
import { normalizarPedidoYavendio, situacionDelPedido } from './yavendio-orders';
import { YavendioCatalogImportService } from './yavendio-catalog-import.service';
import { YavendioOrdersService } from './yavendio-orders.service';

const yavendioProducto = (id: number, name: string, variants: any[]) => ({ id, name, options: [], variants });
const variante = (id: number, name: string, extra: any = {}) => ({ id, name, base_price: '49.9', currency: 'PEN', status: 'available', media: [], ...extra });
const candidato = (id: string, sku: string, name: string, extra: Partial<CandidatoSynkro> = {}): CandidatoSynkro => ({ id, sku, name, price: 49.9, stock: 4, ...extra });

describe('Yavendió: emparejar productos', () => {
    it('distingue las tallas por el nombre (sin SKU) pero lo deja como posible para que lo confirme una persona', () => {
        const grupo = { groupName: 'Polo Negro' };
        const r = sugerirVinculos(
            [yavendioProducto(1, 'Polo Negro', [variante(10, 'Talla M'), variante(11, 'Talla L')])],
            [
                candidato('m', 'POL-M', 'Polo Negro', { ...grupo, variantValues: { Talla: 'M' } }),
                candidato('l', 'POL-L', 'Polo Negro', { ...grupo, variantValues: { Talla: 'L' } }),
            ],
            new Map(),
        );
        // «Polo Negro - Talla M» ≈ «Polo Negro - M»: parecido pero no exacto
        expect(r.map((x) => [x.variantName, x.sugerido?.productId, x.confianza])).toEqual([['Talla M', 'm', 'posible'], ['Talla L', 'l', 'posible']]);
    });

    it('un nombre idéntico da coincidencia segura, y si dos variantes quieren el mismo producto ninguna lo es', () => {
        const unica = sugerirVinculos([yavendioProducto(1, 'Taza Azul', [variante(10, 'Taza Azul')])], [candidato('a', 'T-1', 'Taza  azul')], new Map());
        expect(unica[0].confianza).toBe('alta');

        const doble = sugerirVinculos(
            [yavendioProducto(1, 'Taza Azul', [variante(10, 'Taza Azul')]), yavendioProducto(2, 'Taza Azul', [variante(11, 'Taza Azul')])],
            [candidato('a', 'T-1', 'Taza azul')],
            new Map(),
        );
        expect(doble.map((d) => d.confianza)).toEqual(['posible', 'posible']);
    });

    it('si Yavendió trae SKU y coincide, es coincidencia segura', () => {
        const r = sugerirVinculos([yavendioProducto(1, 'Cualquier cosa', [variante(10, 'x', { sku: 'KI-9' })])], [candidato('a', 'ki-9', 'Otro nombre')], new Map());
        expect(r[0]).toMatchObject({ confianza: 'alta', sugerido: { motivo: 'Mismo SKU' } });
    });

    it('lo ya vinculado no se vuelve a ofrecer, y un producto ocupado tampoco', () => {
        const r = sugerirVinculos(
            [yavendioProducto(1, 'Taza Azul', [variante(10, 'Taza Azul'), variante(11, 'Taza Azul grande')])],
            [candidato('a', 'T-1', 'Taza azul')],
            new Map([['10', 'a']]),
        );
        expect(r[0]).toMatchObject({ vinculadaA: 'T-1', confianza: 'ninguna' });
        expect(r[1].sugerido).toBeNull(); // «a» ya está ocupado por la variante 10
    });

    it('avisa de lo que cambiaría al enviar: precio distinto y falta de stock', () => {
        const r = sugerirVinculos(
            [yavendioProducto(1, 'Taza Azul', [variante(10, 'Taza Azul', { base_price: '30' })])],
            [candidato('a', 'T-1', 'Taza azul', { price: 35, stock: 0 })],
            new Map(),
        );
        expect(r[0].avisos).toHaveLength(2);
    });

    it('lo que no se parece queda sin coincidencia', () => {
        const r = sugerirVinculos([yavendioProducto(1, 'Lámpara', [variante(10, 'Lámpara')])], [candidato('a', 'T-1', 'Taza azul')], new Map());
        expect(r[0]).toMatchObject({ confianza: 'ninguna', sugerido: null });
    });
});

describe('Yavendió: pedidos', () => {
    const pedido = (extra: any = {}) => ({
        id: 77, order_date: '2026-03-10T15:30:00Z', status: 'confirmed', payment_terms: 'paid', payment_method: 'yape', currency: 'PEN',
        total_amount: '139.7', pending_amount: '0', delivery_fee: '10',
        customer: { name: 'María García', phone_number: '+51999888777', document_type: 'DNI', document_number: '123' },
        address: { full_address: 'Av. Larco 1234', country: 'PERU', state: 'Lima', city: 'Lima', district: 'Miraflores' },
        items: [{ variant_id: 500, sku: null, name: 'Polo Negro - M', quantity: 2, base_price: '49.9' }],
        ...extra,
    });

    it('solo los estados confirmados en adelante son ventas', () => {
        expect(situacionDelPedido('confirmed')).toBe('venta');
        expect(situacionDelPedido('delivered')).toBe('venta');
        expect(situacionDelPedido('pending')).toBe('pendiente');
        expect(situacionDelPedido('cancelled')).toBe('anulado');
        expect(situacionDelPedido('rejected')).toBe('anulado');
    });

    it('pasa el pedido al formato común guardando el id de variante en cada línea', () => {
        const n = normalizarPedidoYavendio(pedido());
        expect(n.totalAmount).toBe(139.7);
        expect(n.normalized.customerName).toBe('María García');
        expect(n.normalized.lines[0]).toMatchObject({ title: 'Polo Negro - M', quantity: 2, unitPrice: 49.9, channelVariationId: '500' });
        expect(n.normalized.details.customer).toMatchObject({ phone: '+51999888777', document: 'DNI 123' });
        expect(n.normalized.details.shipping.address).toMatchObject({ line: 'Av. Larco 1234', city: 'Lima', region: 'Lima' });
    });
});

function construirPedidos(opts: { lista: any[]; detalles: Record<string, any>; guardadas?: any[]; enlaces?: any[] }) {
    const guardadas = [...(opts.guardadas ?? [])];
    const api: any = {
        listOrders: jest.fn(async () => opts.lista),
        getOrder: jest.fn(async (_k: string, id: number) => opts.detalles[String(id)]),
    };
    const ordenes: any = {
        find: jest.fn(async () => guardadas),
        create: jest.fn((x: any) => x),
        save: jest.fn(async (x: any) => { guardadas.push(x); return x; }),
        update: jest.fn(async () => undefined),
        delete: jest.fn(async () => undefined),
    };
    const enlaces: any = { find: jest.fn(async () => opts.enlaces ?? []) };
    const sync: any = { resolveConnection: jest.fn(async () => ({ id: 'c1', accessToken: 'k', owner: { id: 'u1' }, store: { id: 's1' }, secrets: { currency: 'PEN' } })) };
    return { svc: new YavendioOrdersService(ordenes, enlaces, api, sync), api, ordenes };
}

const fila = (id: number, status: string) => ({ id, order_date: new Date().toISOString(), status });
const detalle = (id: number, variant: number | null = 500) => ({
    id, order_date: new Date().toISOString(), status: 'confirmed', currency: 'PEN', total_amount: '100', payment_method: 'yape',
    customer: { name: 'Ana' }, address: null, items: [{ variant_id: variant, sku: null, name: 'Polo', quantity: 1, base_price: '90' }],
});

describe('Yavendió: importar pedidos a las ventas', () => {
    it('guarda las ventas confirmadas con el producto vinculado, y deja fuera las pendientes', async () => {
        const { svc, ordenes, api } = construirPedidos({
            lista: [fila(1, 'confirmed'), fila(2, 'pending')],
            detalles: { 1: detalle(1) },
            enlaces: [{ variationId: '500', product: { id: 'p1', sku: 'POL-M' } }],
        });
        const r = await svc.import({ userId: 'u1', storeId: 's1' } as any, undefined);

        expect(r).toMatchObject({ nuevos: 1, omitidos: 1, lineasSinVincular: [] });
        expect(api.getOrder).toHaveBeenCalledTimes(1);
        const guardado = ordenes.save.mock.calls[0][0];
        expect(guardado).toMatchObject({ marketplace: 'yavendio', externalId: '1', status: 'paid', totalAmount: 100, productsAmount: 90, currency: 'PEN' });
        expect(guardado.items[0]).toMatchObject({ productId: 'p1', sku: 'POL-M' });
    });

    it('avisa de las líneas cuya variante no está vinculada y no descuenta nada', async () => {
        const { svc, ordenes } = construirPedidos({ lista: [fila(1, 'confirmed')], detalles: { 1: detalle(1, 999) } });
        const r = await svc.import({ userId: 'u1', storeId: 's1' } as any, undefined);
        expect(r.nuevos).toBe(1);
        expect(r.lineasSinVincular).toEqual([{ pedido: '1', producto: 'Polo', variantId: '999' }]);
        expect(ordenes.save.mock.calls[0][0].items[0]).toMatchObject({ sku: null, reference: 'YV-999' });
        expect(ordenes.save.mock.calls[0][0].items[0].productId).toBeUndefined();
    });

    it('repetir no duplica: lo ya guardado no vuelve a pedirse; un cancelado deja de ser venta', async () => {
        const { svc, ordenes, api } = construirPedidos({
            lista: [fila(1, 'confirmed'), fila(2, 'cancelled')],
            detalles: {},
            guardadas: [
                { id: 'o1', externalId: '1', details: { channelStatus: 'confirmed' } },
                { id: 'o2', externalId: '2', details: { channelStatus: 'confirmed' } },
            ],
        });
        const r = await svc.import({ userId: 'u1', storeId: 's1' } as any, undefined);
        expect(api.getOrder).not.toHaveBeenCalled();
        expect(ordenes.save).not.toHaveBeenCalled();
        expect(ordenes.delete).toHaveBeenCalledWith('o2');
        expect(r).toMatchObject({ nuevos: 0, anulados: 1 });
    });

    it('con dryRun cuenta pero no guarda ni borra', async () => {
        const { svc, ordenes } = construirPedidos({ lista: [fila(1, 'confirmed')], detalles: { 1: detalle(1) } });
        const r = await svc.import({ userId: 'u1', storeId: 's1' } as any, undefined, { dryRun: true });
        expect(r.nuevos).toBe(1);
        expect(ordenes.save).not.toHaveBeenCalled();
    });
});

describe('Yavendió: vincular productos importados', () => {
    function construir(opts: { remoto: any[]; enlaces?: any[]; ventas?: any[] }) {
        const guardados: any[] = [];
        const actualizadas: any[] = [];
        const productos: any = {
            findOne: jest.fn(async ({ where }: any) => ({ id: where.id, sku: 'POL-M', name: 'Polo', group: { parentSku: 'POL' } })),
            find: jest.fn(async () => []),
        };
        const enlaces: any = {
            find: jest.fn(async () => opts.enlaces ?? []),
            findOne: jest.fn(async () => null),
            create: jest.fn((x: any) => x),
            save: jest.fn(async (x: any) => { guardados.push(x); return x; }),
        };
        const ordenes: any = {
            createQueryBuilder: () => ({ where() { return this; }, andWhere() { return this; }, getMany: async () => opts.ventas ?? [] }),
            update: jest.fn(async (id: string, cambios: any) => { actualizadas.push({ id, ...cambios }); }),
        };
        const api: any = { listProducts: jest.fn(async () => opts.remoto) };
        const sync: any = {
            resolveConnection: jest.fn(async () => ({ id: 'c1', accessToken: 'k' })),
            findScopedProduct: jest.fn(async (_s: any, id: string) => { if (id === 'fuera') throw new Error('no'); return { id }; }),
        };
        return { svc: new YavendioCatalogImportService(productos, enlaces, ordenes, api, sync), guardados, api, actualizadas };
    }
    const remoto = [yavendioProducto(1, 'Polo', [variante(10, 'M', { media: [{ id: 1, url: 'https://x/a.jpg' }] })])];
    const scope: any = { userId: 'u1', storeId: 's1' };

    it('crea el enlace con el id del producto y de la variante, sin escribir en Yavendió y con el stock sin definir', async () => {
        const { svc, guardados } = construir({ remoto });
        const r = await svc.link(scope, undefined, [{ productId: 'p1', variantId: '10' }]);
        expect(r).toEqual({ vinculadas: 1, rechazadas: [], ventasCompletadas: 0 });
        expect(guardados[0]).toMatchObject({ marketplace: 'yavendio', externalId: '1', variationId: '10', syncStatus: 'published', lastStockSynced: null, regularPrice: 49.9, imageUrl: 'https://x/a.jpg', parentSku: 'POL' });
    });

    it('al vincular, las ventas anteriores de esa variante quedan asociadas al producto y al SKU, sin tocar las que ya tenían producto', async () => {
        const ventas = [
            { id: 'v1', items: [{ title: 'Polo', channelVariationId: '10', reference: 'YV-10', productId: undefined, sku: null }, { title: 'Otro', channelVariationId: '77' }] },
            { id: 'v2', items: [{ title: 'Polo', channelVariationId: '10', productId: 'ya' , sku: 'X' }] },
        ];
        const { svc, actualizadas } = construir({ remoto, ventas });
        const r = await svc.link(scope, undefined, [{ productId: 'p1', variantId: '10' }]);
        expect(r.ventasCompletadas).toBe(1);
        expect(actualizadas).toHaveLength(1);
        expect(actualizadas[0].items[0]).toMatchObject({ productId: 'p1', sku: 'POL-M', reference: 'YV-10' });
        expect(actualizadas[0].items[1]).toEqual({ title: 'Otro', channelVariationId: '77' });
    });

    it('rechaza una variante inexistente, una ya vinculada y un producto de otra tienda sin frenar el resto', async () => {
        const { svc } = construir({ remoto, enlaces: [{ variationId: '10', product: { id: 'otro' } }] });
        const r = await svc.link(scope, undefined, [
            { productId: 'p1', variantId: '10' },
            { productId: 'p1', variantId: '999' },
            { productId: 'fuera', variantId: '10' },
        ]);
        expect(r.vinculadas).toBe(0);
        expect(r.rechazadas.map((x) => x.variantId)).toEqual(['10', '999', '10']);
    });
});
