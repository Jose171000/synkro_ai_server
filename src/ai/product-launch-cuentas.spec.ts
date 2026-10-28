import { ProductLaunchService } from './product-launch.service';

/**
 * Al lanzar un producto con IA se publica solo en las cuentas que la persona eligió; sin elección, en todas las activas
 * (como antes). Una cuenta elegida que ya no está activa no se sustituye por otra.
 */
const cuenta = (id: string, marketplace = 'mercadolibre') => ({ id, marketplace, status: 'active' });

function construir(cuentas: any[]) {
    const sync: any = {
        getConnections: jest.fn(async () => cuentas),
        enqueuePublish: jest.fn(async () => ({ message: 'ok' })),
        findScopedProduct: jest.fn(async () => ({ id: 'p1', price: 50, marketplaceIds: {}, aiAttributes: {} })),
        familiaDe: jest.fn(async () => [{ id: 'p1', sku: 'S1', price: 50, marketplaceIds: {}, aiAttributes: {} }]),
        nombreParaFalabella: jest.fn((n: string) => String(n).slice(0, 100)),
    };
    const servicio = new ProductLaunchService(sync, {} as any, {} as any, {} as any);
    return { servicio, sync };
}
const scope = { userId: 'u1', storeId: 's1' };

describe('ProductLaunchService con varias cuentas', () => {
    it('publica solo en la cuenta elegida', async () => {
        const { servicio, sync } = construir([cuenta('A'), cuenta('B')]);
        const r = await servicio.lanzar(scope, 'p1', ['mercadolibre'], { mercadolibre: ['B'] });
        expect(sync.enqueuePublish).toHaveBeenCalledTimes(1);
        expect(sync.enqueuePublish).toHaveBeenCalledWith(scope, 'p1', ['mercadolibre'], { mercadolibre: 'B' });
        expect(r.channels[0]).toMatchObject({ marketplace: 'mercadolibre', accounts: 1, status: 'encolado' });
    });

    it('puede publicar en varias cuentas del mismo canal si se eligen', async () => {
        const { servicio, sync } = construir([cuenta('A'), cuenta('B'), cuenta('C')]);
        await servicio.lanzar(scope, 'p1', ['mercadolibre'], { mercadolibre: ['A', 'C'] });
        expect(sync.enqueuePublish.mock.calls.map((c: any[]) => c[3].mercadolibre)).toEqual(['A', 'C']);
    });

    it('sin elección usa todas las cuentas activas, como antes', async () => {
        const { servicio, sync } = construir([cuenta('A'), cuenta('B')]);
        await servicio.lanzar(scope, 'p1', ['mercadolibre']);
        expect(sync.enqueuePublish).toHaveBeenCalledTimes(2);
    });

    it('una cuenta elegida que ya no está activa no se reemplaza por otra: se avisa', async () => {
        const { servicio, sync } = construir([cuenta('A')]);
        const r = await servicio.lanzar(scope, 'p1', ['mercadolibre'], { mercadolibre: ['B'] });
        expect(sync.enqueuePublish).not.toHaveBeenCalled();
        expect(r.channels[0]).toMatchObject({ status: 'omitido' });
        expect(r.channels[0].message).toMatch(/ya no está activa/);
    });

    it('la elección de un canal no afecta a otro', async () => {
        const { servicio, sync } = construir([cuenta('A'), cuenta('B'), cuenta('F', 'falabella')]);
        // Falabella no pasa su preparación en este ejemplo: solo se comprueba que Mercado Libre usó su cuenta elegida.
        await servicio.lanzar(scope, 'p1', ['mercadolibre'], { mercadolibre: ['A'], falabella: ['F'] });
        expect(sync.enqueuePublish).toHaveBeenCalledTimes(1);
        expect(sync.enqueuePublish.mock.calls[0][3]).toEqual({ mercadolibre: 'A' });
    });
});
