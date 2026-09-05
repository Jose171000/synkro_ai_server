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
import { REDIS_CLIENT } from '../redis/redis.module';

/**
 * Traer de un clic las publicaciones que ya existen en Falabella.
 *
 * Lo que se protege aquí es que el tablero no mienta: una ficha rechazada por
 * el control de calidad no se ve en la tienda, así que no puede aparecer como
 * publicada; y la previsualización no puede escribir nada, porque es lo que
 * el cliente mira antes de decidir si quiere cientos de productos nuevos.
 */

const USUARIO = 'usuario-1';

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
            findOne: jest.fn(async ({ where }: any) =>
                productos.find(p => p.sku === where.sku) ?? null),
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

        const modulo = await Test.createTestingModule({
            providers: [
                SyncService,
                { provide: getRepositoryToken(MarketplaceConnection), useValue: vacio },
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

        const resumen = await service.importFalabellaListings(USUARIO);

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

        const resumen = await service.importFalabellaListings(USUARIO);

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

        const resumen = await service.importFalabellaListings(USUARIO);

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

        const resumen = await service.importFalabellaListings(USUARIO);

        expect(resumen.porEstado).toEqual({ published: 1, paused: 2, pending: 1 });
    });

    it('con dryRun no escribe absolutamente nada', async () => {
        const { repoProductos, repoEnlaces } = await construir([
            ficha({ SellerSku: 'NUEVO-1' }),
        ]);

        const resumen = await service.importFalabellaListings(USUARIO, { dryRun: true });

        expect(resumen.total).toBe(1);
        expect(resumen.nuevas).toBe(1);
        expect(resumen.enlazadas).toBe(0);
        expect(repoProductos.save).not.toHaveBeenCalled();
        expect(repoEnlaces.save).not.toHaveBeenCalled();
        expect(notificar).not.toHaveBeenCalled();
    });

    it('no guarda precio cero: un producto sin precio no es un producto regalado', async () => {
        await construir([ficha({}, { Price: '0', SpecialPrice: undefined })]);

        await service.importFalabellaListings(USUARIO);

        expect(productos[0].price).toBeUndefined();
        expect(enlaces[0].lastPriceSynced).toBeNull();
    });

    it('prefiere el precio de oferta al de lista', async () => {
        await construir([ficha({}, { Price: '199.90', SpecialPrice: '149.90' })]);

        await service.importFalabellaListings(USUARIO);

        expect(enlaces[0].lastPriceSynced).toBe(149.9);
    });

    it('salta las fichas sin SKU en vez de romperse', async () => {
        await construir([ficha({ SellerSku: '' as any }), ficha({ SellerSku: 'OK-1' })]);

        const resumen = await service.importFalabellaListings(USUARIO);

        expect(resumen.enlazadas).toBe(1);
    });

    it('avisa cuando el catálogo era demasiado grande y quedó a medias', async () => {
        await construir([ficha()], true);

        const resumen = await service.importFalabellaListings(USUARIO);

        expect(resumen.incompleto).toBe(true);
        expect(notificar).toHaveBeenCalledWith(
            USUARIO,
            expect.objectContaining({ severity: 'warning' }),
        );
    });

    it('al repetir la importación actualiza el enlace en vez de duplicarlo', async () => {
        await construir([ficha({}, { Status: 'active', IsPublished: '1' })]);
        await service.importFalabellaListings(USUARIO);
        expect(enlaces).toHaveLength(1);

        falabella.getAllProducts.mockResolvedValue({
            productos: [ficha({}, { Status: 'inactive', Stock: '0' })],
            incompleto: false,
        });
        await service.importFalabellaListings(USUARIO);

        expect(enlaces).toHaveLength(1);
        expect(enlaces[0].syncStatus).toBe('paused');
        expect(enlaces[0].lastStockSynced).toBe(0);
    });
});
