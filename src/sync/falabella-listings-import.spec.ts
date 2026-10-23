import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { SyncService } from './sync.service';
import { MarketplaceConnection } from './entities/marketplace-connection.entity';
import { ListingLink } from './entities/listing-link.entity';
import { MarketplaceOrder } from './entities/marketplace-order.entity';
import { MarketplaceFeed } from './falabella/entities/marketplace-feed.entity';
import { Product } from '../products/entities/product.entity';
import { MeliApiService } from './meli/meli-api.service';
import { YavendioApiService } from './yavendio/yavendio-api.service';
import { FalabellaApiService, FalabellaBusinessUnit, FalabellaProduct } from './falabella/falabella-api.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SaleAlertsService } from './sale-alerts.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { ChangeRequestsService } from './change-requests.service';
import { StoresService } from '../stores/stores.service';

/**
 * Traer de un clic las publicaciones que ya existen en Falabella.
 *
 * Lo que se protege aquí es que el tablero no mienta: una ficha rechazada por
 * el control de calidad no se ve en la tienda, así que no puede aparecer como
 * publicada; y la previsualización no puede escribir nada, porque es lo que
 * el cliente mira antes de decidir si quiere cientos de productos nuevos.
 */

const USUARIO = 'usuario-1';
const SCOPE = { userId: USUARIO, storeId: 'tienda-1' };

/**
 * Construye una ficha con la forma REAL que devuelve Falabella, comprobada
 * contra la cuenta de producción: el estado, el precio y el stock no están en
 * la raíz sino dentro de la unidad de negocio, y la raíz no trae `Status`.
 */
function ficha(
    over: Partial<FalabellaProduct> = {},
    unidad: Partial<FalabellaBusinessUnit> = {},
): FalabellaProduct {
    return {
        SellerSku: 'SKU-1',
        ShopSku: 'FAL-1',
        Name: 'Gafas de sol',
        Url: 'https://falabella.com.pe/p/1',
        ContentScore: '100',
        QCStatus: 'approved',
        BusinessUnits: {
            BusinessUnit: {
                BusinessUnit: 'Falabella',
                Price: '199.90',
                Stock: '8',
                Status: 'active',
                IsPublished: '1',
                ...unidad,
            },
        },
        ...over,
    };
}

describe('importFalabellaListings', () => {
    let service: SyncService;
    let productos: any[];
    let enlaces: any[];
    let falabella: { getAllProducts: jest.Mock };
    let notificar: jest.Mock;

    async function construir(devuelve: FalabellaProduct[], incompleto = false) {
        productos = [];
        enlaces = [];
        notificar = jest.fn().mockResolvedValue(undefined);
        falabella = {
            getAllProducts: jest.fn().mockResolvedValue({ productos: devuelve, incompleto }),
        };

        const repoProductos = {
            findOne: jest.fn(async ({ where }: any) => {
                const w = Array.isArray(where) ? where[0] : where;
                return productos.find(p => p.sku === w.sku) ?? null;
            }),
            update: jest.fn(),
            create: jest.fn((d: any) => ({ ...d })),
            save: jest.fn(async (p: any) => {
                const guardado = { ...p, id: p.id ?? `prod-${productos.length + 1}` };
                productos.push(guardado);
                return guardado;
            }),
        };

        const repoEnlaces = {
            findOne: jest.fn(async ({ where }: any) =>
                enlaces.find(e => e.product?.id === where.product.id) ?? null),
            create: jest.fn((d: any) => ({ ...d })),
            save: jest.fn(async (e: any) => {
                const i = enlaces.findIndex(x => x.product?.id === e.product?.id);
                if (i >= 0) enlaces[i] = e; else enlaces.push(e);
                return e;
            }),
            find: jest.fn().mockResolvedValue([]),
        };

        const vacio = { findOne: jest.fn(), find: jest.fn(), save: jest.fn(), create: jest.fn() };

        // La cuenta de Falabella de la tienda: una sola, así que se elige sola.
        const cuenta = {
            id: 'cuenta-1', marketplace: 'falabella', externalUserId: 'a@b.com', accessToken: 'clave',
            status: 'active', currency: 'PEN', owner: { id: USUARIO }, store: { id: 'tienda-1' },
        };
        const repoConexiones = {
            ...vacio,
            find: jest.fn().mockResolvedValue([{ id: cuenta.id }]),
            findOne: jest.fn().mockResolvedValue(cuenta),
        };

        const modulo = await Test.createTestingModule({
            providers: [
                SyncService,
                { provide: getRepositoryToken(MarketplaceConnection), useValue: repoConexiones },
                { provide: getRepositoryToken(ListingLink), useValue: repoEnlaces },
                { provide: getRepositoryToken(MarketplaceOrder), useValue: vacio },
                { provide: getRepositoryToken(MarketplaceFeed), useValue: vacio },
                { provide: getRepositoryToken(Product), useValue: repoProductos },
                { provide: getQueueToken('marketplace-sync-queue'), useValue: { add: jest.fn() } },
                { provide: REDIS_CLIENT, useValue: { set: jest.fn(), get: jest.fn() } },
                { provide: MeliApiService, useValue: {} },
                { provide: YavendioApiService, useValue: {} },
                { provide: FalabellaApiService, useValue: falabella },
                { provide: NotificationsService, useValue: { notify: notificar } },
                { provide: SaleAlertsService, useValue: { notificar: jest.fn() } },
                { provide: ChangeRequestsService, useValue: {} },
                { provide: StoresService, useValue: {} },
            ],
        }).compile();

        service = modulo.get(SyncService);
        // Las credenciales se piden a una conexión que aquí no existe.
        jest.spyOn(service, 'getFalabellaCredentials')
            .mockResolvedValue({ userId: 'a@b.com', apiKey: 'clave' });
        return { repoProductos, repoEnlaces };
    }

    it('enlaza una ficha activa con el producto que ya está en el catálogo', async () => {
        const { repoProductos } = await construir([ficha()]);
        productos.push({ id: 'prod-existente', sku: 'SKU-1', name: 'Gafas' });

        const resumen = await service.importFalabellaListings(SCOPE, undefined);

        expect(resumen.total).toBe(1);
        expect(resumen.yaEnCatalogo).toBe(1);
        expect(resumen.nuevas).toBe(0);
        expect(resumen.enlazadas).toBe(1);
        // No debe crear un producto que ya existía.
        expect(repoProductos.create).not.toHaveBeenCalled();

        expect(enlaces[0]).toMatchObject({
            marketplace: 'falabella',
            externalId: 'FAL-1',
            permalink: 'https://falabella.com.pe/p/1',
            syncStatus: 'published',
            lastStockSynced: 8,
        });
    });

    it('crea como borrador la publicación que no está en el catálogo', async () => {
        await construir([ficha({ SellerSku: 'NUEVO-1', Name: 'Reloj' })]);

        const resumen = await service.importFalabellaListings(SCOPE, undefined);

        expect(resumen.nuevas).toBe(1);
        expect(productos[0]).toMatchObject({
            sku: 'NUEVO-1',
            name: 'Reloj',
            status: 'draft',
            stock: 8,
        });
    });

    it('una ficha rechazada por control de calidad NO se muestra como publicada', async () => {
        // Es el caso que este módulo viene a arreglar: en la hoja de cálculo
        // figuraba como "Visible" algo que el comprador no podía ver.
        await construir([ficha({ QCStatus: 'rejected' }, { Status: 'active' })]);

        const resumen = await service.importFalabellaListings(SCOPE, undefined);

        expect(resumen.porEstado).toEqual({ error: 1 });
        expect(enlaces[0].syncStatus).toBe('error');
        expect(enlaces[0].lastError).toMatch(/control de calidad/i);
    });

    it('traduce los estados de Falabella a los nuestros', async () => {
        await construir([
            ficha({ SellerSku: 'A' }, { Status: 'active', IsPublished: '1' }),
            ficha({ SellerSku: 'B' }, { Status: 'inactive' }),
            ficha({ SellerSku: 'C' }, { Status: 'deleted' }),
            // Aprobada pero todavía no visible en la tienda: no es "publicada".
            ficha({ SellerSku: 'D' }, { Status: 'active', IsPublished: '0' }),
        ]);

        const resumen = await service.importFalabellaListings(SCOPE, undefined);

        expect(resumen.porEstado).toEqual({ published: 1, paused: 2, pending: 1 });
    });

    it('con dryRun no escribe absolutamente nada', async () => {
        const { repoProductos, repoEnlaces } = await construir([
            ficha({ SellerSku: 'NUEVO-1' }),
        ]);

        const resumen = await service.importFalabellaListings(SCOPE, undefined, { dryRun: true });

        expect(resumen.total).toBe(1);
        expect(resumen.nuevas).toBe(1);
        expect(resumen.enlazadas).toBe(0);
        expect(repoProductos.save).not.toHaveBeenCalled();
        expect(repoEnlaces.save).not.toHaveBeenCalled();
        expect(notificar).not.toHaveBeenCalled();
    });

    it('no guarda precio cero: un producto sin precio no es un producto regalado', async () => {
        await construir([ficha({}, { Price: '0', SpecialPrice: undefined })]);

        await service.importFalabellaListings(SCOPE, undefined);

        expect(productos[0].price).toBeUndefined();
        expect(enlaces[0].lastPriceSynced).toBeNull();
    });

    it('guarda el precio regular como del producto y el descuento aparte, en la publicación', async () => {
        // Synkro manda de vuelta el regular al editar; si guardara el rebajado,
        // el siguiente envío dejaría el regular por debajo de la promoción.
        await construir([ficha({}, { Price: '199.90', SpecialPrice: '149.90' })]);

        await service.importFalabellaListings(SCOPE, undefined);

        expect(productos[0].price).toBe(199.9);
        expect(enlaces[0].lastPriceSynced).toBe(199.9);
        expect(enlaces[0].regularPrice).toBe(199.9);
        expect(enlaces[0].salePrice).toBe(149.9);
    });

    it('trae la imagen de cada variante y su nombre de variante', async () => {
        await construir([ficha({
            SellerSku: 'CAMISA-M-ROJO',
            Variation: 'M / Rojo',
            ParentSku: 'CAMISA',
            MainImage: 'https://img.falabella/rojo.jpg',
            Images: { Image: ['https://img.falabella/rojo.jpg', 'https://img.falabella/rojo-2.jpg'] },
        })]);

        await service.importFalabellaListings(SCOPE, undefined);

        expect(enlaces[0].imageUrl).toBe('https://img.falabella/rojo.jpg');
        expect(enlaces[0].variation).toBe('M / Rojo');
        expect(enlaces[0].parentSku).toBe('CAMISA');
        expect(productos[0].images).toEqual([
            { url: 'https://img.falabella/rojo.jpg' },
            { url: 'https://img.falabella/rojo-2.jpg' },
        ]);
    });

    it('corrige al regular un producto importado antes con el precio rebajado, si nadie lo editó', async () => {
        const { repoProductos } = await construir([ficha({}, { Price: '199.90', SpecialPrice: '149.90' })]);
        productos.push({ id: 'p-viejo', sku: 'SKU-1', name: 'Gafas', price: 149.9 });
        enlaces.push({ marketplace: 'falabella', product: { id: 'p-viejo' }, lastPriceSynced: 149.9 });

        await service.importFalabellaListings(SCOPE, undefined);

        expect(productos[0].price).toBe(199.9);
        expect(repoProductos.save).toHaveBeenCalled();
    });

    it('no pisa un precio que el usuario ya editó', async () => {
        await construir([ficha({}, { Price: '199.90', SpecialPrice: '149.90' })]);
        productos.push({ id: 'p-editado', sku: 'SKU-1', name: 'Gafas', price: 170 });
        enlaces.push({ marketplace: 'falabella', product: { id: 'p-editado' }, lastPriceSynced: 149.9 });

        await service.importFalabellaListings(SCOPE, undefined);

        expect(productos[0].price).toBe(170);
    });

    it('salta las fichas sin SKU en vez de romperse', async () => {
        await construir([ficha({ SellerSku: '' as any }), ficha({ SellerSku: 'OK-1' })]);

        const resumen = await service.importFalabellaListings(SCOPE, undefined);

        expect(resumen.enlazadas).toBe(1);
    });

    it('avisa cuando el catálogo era demasiado grande y quedó a medias', async () => {
        await construir([ficha()], true);

        const resumen = await service.importFalabellaListings(SCOPE, undefined);

        expect(resumen.incompleto).toBe(true);
        expect(notificar).toHaveBeenCalledWith(
            USUARIO,
            expect.objectContaining({ severity: 'warning' }),
        );
    });

    it('al repetir la importación actualiza el enlace en vez de duplicarlo', async () => {
        await construir([ficha({}, { Status: 'active', IsPublished: '1' })]);
        await service.importFalabellaListings(SCOPE, undefined);
        expect(enlaces).toHaveLength(1);

        falabella.getAllProducts.mockResolvedValue({
            productos: [ficha({}, { Status: 'inactive', Stock: '0' })],
            incompleto: false,
        });
        await service.importFalabellaListings(SCOPE, undefined);

        expect(enlaces).toHaveLength(1);
        expect(enlaces[0].syncStatus).toBe('paused');
        expect(enlaces[0].lastStockSynced).toBe(0);
    });

    it('cada publicación queda ligada a la cuenta de la que se importó', async () => {
        await construir([ficha()]);

        await service.importFalabellaListings(SCOPE, undefined);

        expect(enlaces[0].connection).toEqual({ id: 'cuenta-1' });
    });

    it('el producto nuevo nace en la tienda desde la que se importa', async () => {
        await construir([ficha({ SellerSku: 'NUEVO-9' })]);

        await service.importFalabellaListings(SCOPE, undefined);

        expect(productos[0].store).toEqual({ id: 'tienda-1' });
    });

    it('un SKU que ya existe en OTRA tienda del mismo dueño no se toca ni se enlaza', async () => {
        await construir([ficha({ SellerSku: 'COMPARTIDO' })]);
        productos.push({ id: 'p-otra', sku: 'COMPARTIDO', name: 'Otro', store: { id: 'tienda-2' } });

        const resumen = await service.importFalabellaListings(SCOPE, undefined);

        expect(resumen.enOtraTienda).toBe(1);
        expect(resumen.enlazadas).toBe(0);
        expect(enlaces).toHaveLength(0);
    });

    it('un producto anterior a las tiendas (sin tienda) se adopta en la tienda que importa', async () => {
        const { repoProductos } = await construir([ficha()]);
        productos.push({ id: 'p-viejo', sku: 'SKU-1', name: 'Gafas' });

        await service.importFalabellaListings(SCOPE, undefined);

        expect(repoProductos.update).toHaveBeenCalledWith('p-viejo', { store: { id: 'tienda-1' } });
    });

    describe('variantes (mismo ParentSku)', () => {
        const variantes = () => [
            ficha({ SellerSku: 'SAB-BE', ShopSku: 'S1', Name: 'Sábanas Royal Beige', ParentSku: 'SAB-ROYAL', ProductData: { Color: 'Beige' }, MainImage: 'https://img/beige.jpg' }),
            ficha({ SellerSku: 'SAB-BL', ShopSku: 'S2', Name: 'Sábanas Royal Blanco', ParentSku: 'SAB-ROYAL', ProductData: { Color: 'Blanco' }, MainImage: 'https://img/blanco.jpg' }),
        ];

        it('la vista previa cuenta los grupos y sus ejes sin crear nada', async () => {
            await construir(variantes());
            const aplicar = jest.fn();
            (service as any).variantImport = { aplicar };

            const resumen = await service.importFalabellaListings(SCOPE, undefined, { dryRun: true });

            expect(resumen.variantes.grupos).toBe(1);
            expect(resumen.variantes.variantes).toBe(2);
            expect(resumen.variantes.ejemplos[0]).toMatchObject({ parentSku: 'SAB-ROYAL', variantes: 2, ejes: [{ name: 'Color', values: ['Beige', 'Blanco'] }] });
            expect(aplicar).not.toHaveBeenCalled();
            expect(productos).toHaveLength(0);
        });

        it('al importar de verdad, cada variante conserva su propia foto y se agrupan juntas', async () => {
            await construir(variantes());
            const aplicar = jest.fn(async () => ({ gruposCreados: 1, gruposActualizados: 0, variantesAgrupadas: 2, omitidos: [] }));
            (service as any).variantImport = { aplicar };

            const resumen = await service.importFalabellaListings(SCOPE, undefined);

            expect(productos.map(p => [p.sku, p.images[0].url])).toEqual([['SAB-BE', 'https://img/beige.jpg'], ['SAB-BL', 'https://img/blanco.jpg']]);
            expect(aplicar).toHaveBeenCalledTimes(1);
            const [, grupos, porSku] = aplicar.mock.calls[0] as any[];
            expect(grupos[0].variants.map((v: any) => v.sellerSku)).toEqual(['SAB-BE', 'SAB-BL']);
            expect([...porSku.keys()]).toEqual(['SAB-BE', 'SAB-BL']);
            expect(resumen.variantes.aplicado).toMatchObject({ gruposCreados: 1, variantesAgrupadas: 2 });
        });

        describe('con la página pública', () => {
            const URL_P = 'https://www.falabella.com.pe/falabella-pe/product/153461795/Sabana-King/153461796';
            const mismaPagina = () => [
                ficha({ SellerSku: 'BL-K-RPA', ShopSku: 'S1', Name: 'Sábana King', ParentSku: 'BL-K-RPA', Url: URL_P, ProductData: { ColorBasico: 'Gris' } }),
                ficha({ SellerSku: 'BL-K-NGR', ShopSku: 'S2', Name: 'Sábana King', ParentSku: 'BL-K-RPA', Url: URL_P, ProductData: { ColorBasico: 'Gris' } }),
            ];
            const lecturaBuena = {
                ok: true, productId: '153461795',
                variantes: [
                    { variantId: '1', sellerSkus: ['BL-K-RPA'], size: 'King', colorName: 'Rosado', colorCode: '#FFC0CB', atributos: { size: 'King', colorName: 'Rosado' } },
                    { variantId: '2', sellerSkus: ['BL-K-NGR'], size: 'King', colorName: 'Negro', colorCode: '#000000', atributos: { size: 'King', colorName: 'Negro' } },
                ],
            };

            it('lo que los atributos no resuelven se completa con color y talla reales de la página', async () => {
                await construir(mismaPagina());
                const leer = jest.fn(async () => lecturaBuena);
                (service as any).publicPage = { leer };
                (service as any).variantImport = { aplicar: jest.fn() };

                const resumen = await service.importFalabellaListings(SCOPE, undefined, { dryRun: true });

                expect(leer).toHaveBeenCalledWith(URL_P);
                expect(resumen.variantes.grupos).toBe(1);
                expect(resumen.variantes.sinResolver).toEqual([]);
                expect(resumen.variantes.ejemplos[0].ejes).toEqual([{ name: 'Color', values: ['Rosado', 'Negro'] }]);
                expect(resumen.variantes.paginaPublica).toMatchObject({ familias: 1, leidas: 1, resueltas: 1, bloqueada: false });
            });

            it('si Falabella bloquea la lectura, se detiene y no agrupa nada a ciegas', async () => {
                await construir(mismaPagina());
                const leer = jest.fn(async () => ({ ok: false, bloqueada: true, motivo: 'bloqueada', variantes: [] }));
                (service as any).publicPage = { leer };

                const resumen = await service.importFalabellaListings(SCOPE, undefined, { dryRun: true });

                expect(resumen.variantes.grupos).toBe(0);
                expect(resumen.variantes.paginaPublica.bloqueada).toBe(true);
            });

            it('si la página cambió o no trae las variantes, las familias quedan sin agrupar y se informa el motivo', async () => {
                await construir(mismaPagina());
                (service as any).publicPage = { leer: jest.fn(async () => ({ ok: false, motivo: 'la página no trae los datos esperados', variantes: [] })) };

                const resumen = await service.importFalabellaListings(SCOPE, undefined, { dryRun: true });

                expect(resumen.variantes.grupos).toBe(0);
                expect(resumen.variantes.paginaPublica.sinDatos[0].motivo).toMatch(/datos esperados/);
            });

            it('lo que ya resolvieron los atributos no vuelve a pedir la página', async () => {
                await construir([
                    ficha({ SellerSku: 'A', ParentSku: 'P', Url: URL_P, ProductData: { Color: 'Rojo' } }),
                    ficha({ SellerSku: 'B', ParentSku: 'P', Url: URL_P, ProductData: { Color: 'Azul' } }),
                ]);
                const leer = jest.fn();
                (service as any).publicPage = { leer };

                const resumen = await service.importFalabellaListings(SCOPE, undefined, { dryRun: true });

                expect(resumen.variantes.grupos).toBe(1);
                expect(leer).not.toHaveBeenCalled();
            });
        });

        describe('con IA como segundo recurso', () => {
            const sinAtributos = () => [
                ficha({ SellerSku: 'S-ROSA', Name: 'Sábana King Rosa Pastel', ParentSku: 'FAM', ProductData: {} }),
                ficha({ SellerSku: 'S-NEGRO', Name: 'Sábana King Negro', ParentSku: 'FAM', ProductData: {} }),
            ];

            it('si la página no dio los ejes, la IA los propone y, comprobados contra cada ficha, se agrupa', async () => {
                await construir(sinAtributos());
                const proponer = jest.fn(async () => ({ ejes: [{ nombre: 'Color' }], valores: { 'S-ROSA': { Color: 'Rosa Pastel' }, 'S-NEGRO': { Color: 'Negro' } }, confianza: 'alta' as const }));
                service.proponerEjesConIA = proponer;

                const resumen = await service.importFalabellaListings(SCOPE, undefined, { dryRun: true });

                expect(proponer).toHaveBeenCalledTimes(1);
                expect(resumen.variantes.ia).toMatchObject({ intentadas: 1, resueltas: 1 });
                expect(resumen.variantes.grupos).toBe(1);
                expect(resumen.variantes.sinResolver).toEqual([]);
            });

            it('una propuesta que no se puede comprobar no se aplica: queda para la revisión manual con la sugerencia', async () => {
                await construir(sinAtributos());
                service.proponerEjesConIA = jest.fn(async () => ({ ejes: [{ nombre: 'Color' }], valores: { 'S-ROSA': { Color: 'Fucsia' }, 'S-NEGRO': { Color: 'Gris' } }, confianza: 'alta' as const }));

                const resumen = await service.importFalabellaListings(SCOPE, undefined, { dryRun: true });

                expect(resumen.variantes.grupos).toBe(0);
                expect(resumen.variantes.ia.resueltas).toBe(0);
                const g = resumen.variantes.sinResolver[0];
                expect(g.motivo).toMatch(/IA:.*no se puede comprobar/);
                expect(g.fichas).toEqual([{ sku: 'S-ROSA', nombre: 'Sábana King Rosa Pastel', imagen: null }, { sku: 'S-NEGRO', nombre: 'Sábana King Negro', imagen: null }]);
                expect(g.sugerencia?.ejes).toEqual(['Color']);
            });

            it('la propuesta de la IA se recuerda: abrir la vista previa de nuevo no repite la consulta', async () => {
                await construir(sinAtributos());
                const memoria = new Map<string, string>();
                (service as any).redis = { get: jest.fn(async (k: string) => memoria.get(k) ?? null), set: jest.fn(async (k: string, v: string) => { memoria.set(k, v); }) };
                const proponer = jest.fn(async () => ({ ejes: [{ nombre: 'Color' }], valores: { 'S-ROSA': { Color: 'Rosa Pastel' }, 'S-NEGRO': { Color: 'Negro' } }, confianza: 'alta' as const }));
                service.proponerEjesConIA = proponer;

                await service.importFalabellaListings(SCOPE, undefined, { dryRun: true });
                const segunda = await service.importFalabellaListings(SCOPE, undefined, { dryRun: true });

                expect(proponer).toHaveBeenCalledTimes(1);
                expect(segunda.variantes.grupos).toBe(1);
            });

            it('si la IA falla, la familia pasa a la revisión manual sin romper la importación', async () => {
                await construir(sinAtributos());
                service.proponerEjesConIA = jest.fn(async () => { throw new Error('IA caída'); });

                const resumen = await service.importFalabellaListings(SCOPE, undefined, { dryRun: true });

                expect(resumen.variantes.sinResolver).toHaveLength(1);
            });

            it('no consulta a la IA por familias que los atributos ya resolvieron', async () => {
                await construir([
                    ficha({ SellerSku: 'A', ParentSku: 'P', ProductData: { Color: 'Rojo' } }),
                    ficha({ SellerSku: 'B', ParentSku: 'P', ProductData: { Color: 'Azul' } }),
                ]);
                const proponer = jest.fn();
                service.proponerEjesConIA = proponer;

                await service.importFalabellaListings(SCOPE, undefined, { dryRun: true });

                expect(proponer).not.toHaveBeenCalled();
            });
        });

        it('productos sueltos no forman grupos y no se llama a agrupar', async () => {
            await construir([ficha({ SellerSku: 'A', ParentSku: 'A' }), ficha({ SellerSku: 'B', ParentSku: 'B' })]);
            const aplicar = jest.fn();
            (service as any).variantImport = { aplicar };

            const resumen = await service.importFalabellaListings(SCOPE, undefined);

            expect(resumen.variantes.grupos).toBe(0);
            expect(aplicar).not.toHaveBeenCalled();
        });
    });
});
