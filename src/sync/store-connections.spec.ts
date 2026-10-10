import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { SyncService, MAX_ACCOUNTS_PER_MARKETPLACE } from './sync.service';
import { MarketplaceConnection } from './entities/marketplace-connection.entity';
import { ListingLink } from './entities/listing-link.entity';
import { MarketplaceOrder } from './entities/marketplace-order.entity';
import { MarketplaceFeed } from './falabella/entities/marketplace-feed.entity';
import { Product } from '../products/entities/product.entity';
import { MeliApiService } from './meli/meli-api.service';
import { YavendioApiService } from './yavendio/yavendio-api.service';
import { FalabellaApiService } from './falabella/falabella-api.service';
import { NotificationsService } from '../notifications/notifications.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { ChangeRequestsService } from './change-requests.service';
import { StoresService } from '../stores/stores.service';

/**
 * Cuentas de canales por tienda. Lo que se protege: una tienda ve SOLO sus
 * cuentas, admite como mucho 3 del mismo canal, reconectar una cuenta no
 * cuenta como una nueva, y con varias cuentas nunca se adivina cuál usar.
 */
const SCOPE_A = { userId: 'ana', storeId: 'tienda-a' };
const SCOPE_B = { userId: 'ana', storeId: 'tienda-b' };

function conexion(id: string, storeId: string, marketplace = 'falabella', externalUserId = id) {
    return {
        id, marketplace, externalUserId, accessToken: 'secreto', refreshToken: null, secrets: null,
        status: 'active', store: { id: storeId }, owner: { id: 'ana' }, label: null, createdAt: new Date(),
    } as any;
}

async function construir(conexiones: any[]) {
    const guardadas: any[] = [];
    const repoConexiones = {
        find: jest.fn(async ({ where }: any) =>
            conexiones.filter(c =>
                (!where.store || c.store.id === where.store.id) &&
                (!where.marketplace || c.marketplace === where.marketplace) &&
                (!where.status || c.status === where.status))),
        findOne: jest.fn(async ({ where }: any) =>
            conexiones.find(c =>
                (!where.id || c.id === where.id) &&
                (!where.store || c.store.id === where.store.id) &&
                (!where.marketplace || c.marketplace === where.marketplace) &&
                (!where.externalUserId || c.externalUserId === where.externalUserId) &&
                (!where.status || c.status === where.status)) ?? null),
        count: jest.fn(async ({ where }: any) =>
            conexiones.filter(c => c.marketplace === where.marketplace && c.store.id === where.store.id).length),
        create: jest.fn((d: any) => ({ ...d })),
        save: jest.fn(async (c: any) => { const g = { ...c, id: c.id ?? `nueva-${guardadas.length + 1}` }; guardadas.push(g); return g; }),
        remove: jest.fn(async (c: any) => c),
        update: jest.fn(),
    };
    const repoEnlaces = { find: jest.fn().mockResolvedValue([]), save: jest.fn() };
    const vacio = { findOne: jest.fn(), find: jest.fn(), save: jest.fn(), create: jest.fn() };

    const modulo = await Test.createTestingModule({
        providers: [
            SyncService,
            { provide: getRepositoryToken(MarketplaceConnection), useValue: repoConexiones },
            { provide: getRepositoryToken(ListingLink), useValue: repoEnlaces },
            { provide: getRepositoryToken(MarketplaceOrder), useValue: vacio },
            { provide: getRepositoryToken(MarketplaceFeed), useValue: vacio },
            { provide: getRepositoryToken(Product), useValue: vacio },
            { provide: getQueueToken('marketplace-sync-queue'), useValue: { add: jest.fn() } },
            { provide: REDIS_CLIENT, useValue: { setex: jest.fn(), get: jest.fn(), del: jest.fn() } },
            { provide: MeliApiService, useValue: {} },
            { provide: YavendioApiService, useValue: {} },
            { provide: FalabellaApiService, useValue: { verifyCredentials: jest.fn().mockResolvedValue(undefined) } },
            { provide: NotificationsService, useValue: { notify: jest.fn() } },
            { provide: ChangeRequestsService, useValue: {} },
            { provide: StoresService, useValue: {} },
        ],
    }).compile();

    return { service: modulo.get(SyncService), repoConexiones, repoEnlaces, guardadas };
}

describe('cuentas por tienda', () => {
    it('cada tienda ve solo sus cuentas y nunca sus credenciales', async () => {
        const { service } = await construir([
            conexion('a1', 'tienda-a'), conexion('a2', 'tienda-a', 'mercadolibre'), conexion('b1', 'tienda-b'),
        ]);

        const deA = await service.getConnections('tienda-a');
        expect(deA.map((c: any) => c.id)).toEqual(['a1', 'a2']);
        expect(deA[0]).not.toHaveProperty('accessToken');
        expect(deA[0]).not.toHaveProperty('secrets');

        const deB = await service.getConnections('tienda-b');
        expect(deB.map((c: any) => c.id)).toEqual(['b1']);
    });

    it('admite hasta 3 cuentas del mismo canal y rechaza la cuarta', async () => {
        const { service } = await construir([
            conexion('f1', 'tienda-a', 'falabella', 'uno@x.com'),
            conexion('f2', 'tienda-a', 'falabella', 'dos@x.com'),
            conexion('f3', 'tienda-a', 'falabella', 'tres@x.com'),
        ]);
        expect(MAX_ACCOUNTS_PER_MARKETPLACE).toBe(3);

        await expect(service.connectFalabella(SCOPE_A, { userId: 'cuatro@x.com', apiKey: 'k' }))
            .rejects.toThrow(/hasta 3 cuentas/i);
    });

    it('reconectar una cuenta que ya está no cuenta como una nueva', async () => {
        const { service, guardadas } = await construir([
            conexion('f1', 'tienda-a', 'falabella', 'uno@x.com'),
            conexion('f2', 'tienda-a', 'falabella', 'dos@x.com'),
            conexion('f3', 'tienda-a', 'falabella', 'tres@x.com'),
        ]);

        const res = await service.connectFalabella(SCOPE_A, { userId: 'dos@x.com', apiKey: 'nueva-clave' });

        expect(res.id).toBe('f2');
        expect(guardadas[0]).toMatchObject({ id: 'f2', accessToken: 'nueva-clave' });
    });

    it('el límite es por tienda y por canal: otra tienda parte de cero', async () => {
        const { service } = await construir([
            conexion('f1', 'tienda-a', 'falabella', 'uno@x.com'),
            conexion('f2', 'tienda-a', 'falabella', 'dos@x.com'),
            conexion('f3', 'tienda-a', 'falabella', 'tres@x.com'),
        ]);

        await expect(service.connectFalabella(SCOPE_B, { userId: 'cuatro@x.com', apiKey: 'k' })).resolves.toBeTruthy();
    });

    it('la nueva cuenta queda en la tienda que la conecta, con el dueño que actúa', async () => {
        const { service, guardadas } = await construir([]);

        await service.connectFalabella(SCOPE_B, { userId: 'nuevo@x.com', apiKey: 'k', label: 'Cuenta Perú' });

        expect(guardadas[0]).toMatchObject({
            marketplace: 'falabella', externalUserId: 'nuevo@x.com',
            store: { id: 'tienda-b' }, owner: { id: 'ana' }, label: 'Cuenta Perú',
        });
    });
});

describe('elegir la cuenta a usar', () => {
    it('con una sola cuenta del canal se usa sin preguntar', async () => {
        const { service } = await construir([conexion('f1', 'tienda-a')]);
        await expect(service.resolveConnection('tienda-a', 'falabella')).resolves.toMatchObject({ id: 'f1' });
    });

    it('con varias cuentas del canal exige indicar cuál: nunca adivina', async () => {
        const { service } = await construir([conexion('f1', 'tienda-a'), conexion('f2', 'tienda-a')]);
        await expect(service.resolveConnection('tienda-a', 'falabella')).rejects.toThrow(/2 cuentas.*Indica cuál/i);
    });

    it('con el id se usa esa cuenta aunque haya varias', async () => {
        const { service } = await construir([conexion('f1', 'tienda-a'), conexion('f2', 'tienda-a')]);
        await expect(service.resolveConnection('tienda-a', 'falabella', 'f2')).resolves.toMatchObject({ id: 'f2' });
    });

    it('una cuenta de OTRA tienda no se puede usar aunque se conozca su id', async () => {
        const { service } = await construir([conexion('b1', 'tienda-b')]);
        await expect(service.resolveConnection('tienda-a', 'falabella', 'b1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('sin ninguna cuenta del canal pide conectarla', async () => {
        const { service } = await construir([conexion('a1', 'tienda-a', 'mercadolibre')]);
        await expect(service.resolveConnection('tienda-a', 'falabella')).rejects.toBeInstanceOf(BadRequestException);
    });
});

describe('desconectar', () => {
    it('quita la cuenta indicada de la tienda', async () => {
        const f1 = '33333333-3333-3333-3333-333333333333';
        const f2 = '44444444-4444-4444-4444-444444444444';
        const { service, repoConexiones } = await construir([conexion(f1, 'tienda-a'), conexion(f2, 'tienda-a')]);
        await service.disconnect('tienda-a', f1);
        expect(repoConexiones.remove).toHaveBeenCalledTimes(1);
        expect(repoConexiones.remove).toHaveBeenCalledWith(expect.objectContaining({ id: f1 }));
    });

    it('no puede quitar una cuenta de otra tienda', async () => {
        const { service, repoConexiones } = await construir([conexion('11111111-1111-1111-1111-111111111111', 'tienda-b')]);
        await expect(service.disconnect('tienda-a', '11111111-1111-1111-1111-111111111111')).rejects.toBeInstanceOf(NotFoundException);
        expect(repoConexiones.remove).not.toHaveBeenCalled();
    });

    it('por compatibilidad acepta el nombre del canal si la tienda tiene una sola cuenta', async () => {
        const { service, repoConexiones } = await construir([conexion('f1', 'tienda-a')]);
        await service.disconnect('tienda-a', 'falabella');
        expect(repoConexiones.remove).toHaveBeenCalled();
    });

    it('con el nombre del canal y varias cuentas no adivina cuál quitar', async () => {
        const { service, repoConexiones } = await construir([conexion('f1', 'tienda-a'), conexion('f2', 'tienda-a')]);
        await expect(service.disconnect('tienda-a', 'falabella')).rejects.toThrow(/Indica cuál/i);
        expect(repoConexiones.remove).not.toHaveBeenCalled();
    });
});
