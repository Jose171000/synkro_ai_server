import { AiProcessor } from './ai.processor';
import { BatchNotificationService } from './batch-notification.service';
import { BulkBatchService } from './bulk-batch.service';
import { tamanoDeTandaFalabella } from './tanda-falabella';

describe('tamaño de la tanda de Falabella', () => {
    it('sin variable o con un valor que no sirve no hay tandas: todo el lote al final, como siempre', () => {
        for (const v of [undefined, '', '  ', 'abc', '0', '-5', '2.5', '200 productos']) expect(tamanoDeTandaFalabella(v)).toBe(0);
    });

    it('toma el número que se le da y tiene un tope de 500', () => {
        expect(tamanoDeTandaFalabella(' 200 ')).toBe(200);
        expect(tamanoDeTandaFalabella('5000')).toBe(500);
    });
});

/** Un Redis en memoria con los conjuntos que usa la lista de productos pendientes. */
function redisConConjuntos() {
    const conjuntos = new Map<string, Set<string>>();
    const set = (k: string) => conjuntos.get(k) ?? conjuntos.set(k, new Set()).get(k)!;
    return {
        conjuntos,
        multi: () => {
            const cola: (() => unknown)[] = [];
            const tx: any = {
                sadd: (k: string, v: string) => { cola.push(() => (set(k).add(v), 1)); return tx; },
                expire: () => { cola.push(() => 1); return tx; },
                scard: (k: string) => { cola.push(() => set(k).size); return tx; },
                smembers: (k: string) => { cola.push(() => [...set(k)]); return tx; },
                del: (k: string) => { cola.push(() => (conjuntos.delete(k), 1)); return tx; },
                exec: async () => cola.map((c) => [null, c()]),
            };
            return tx;
        },
        spop: async (k: string, n: number) => { const s = set(k); const sacados = [...s].slice(0, n); sacados.forEach((x) => s.delete(x)); return sacados; },
    };
}

/** El registro del lote en la base, también en memoria. */
function baseEnMemoria() {
    const items = new Map<string, { sku: string; productId: string; falabellaStatus: string | null; falabellaError: string | null }>();
    const repoItems: any = {
        update: jest.fn(async (donde: any, cambios: any) => {
            for (const i of items.values()) {
                const coincide = (donde.productId === undefined || (donde.productId?._value ? donde.productId._value.includes(i.productId) : donde.productId === i.productId))
                    && (donde.sku === undefined || donde.sku === i.sku);
                if (coincide) Object.assign(i, cambios);
            }
        }),
        find: jest.fn(async ({ where }: any) => [...items.values()].filter((i) => i.falabellaStatus === where.falabellaStatus)),
    };
    const servicio = new BulkBatchService({} as any, repoItems);
    return { servicio, items };
}

describe('envío a Falabella por tandas', () => {
    const construir = (tanda: string | undefined) => {
        process.env.FALABELLA_BATCH_SIZE = tanda as any;
        if (tanda === undefined) delete process.env.FALABELLA_BATCH_SIZE;
        const redis = redisConConjuntos();
        const lote = new BatchNotificationService(redis as any, {} as any);
        const { servicio, items } = baseEnMemoria();
        const publicados: string[][] = [];
        const sync: any = {
            getConnections: jest.fn(async () => [{ id: 'c1', status: 'active', marketplace: 'falabella' }]),
            publishBatchToFalabella: jest.fn(async (_s: any, _c: string, ids: string[]) => { publicados.push(ids); return { enviados: ids.length, rechazados: [] }; }),
            avisarProductosPorRevisar: jest.fn(async () => undefined),
        };
        const prep: any = { preparar: jest.fn(async (_s: any, id: string) => ({ category: '1', sku: id })) };
        const procesador: any = new AiProcessor({} as any, {} as any, sync, prep, lote, servicio);
        const agregar = async (n: number) => {
            for (let i = 1; i <= n; i++) {
                const id = `p${i}`;
                items.set(id, { sku: `SKU-${i}`, productId: id, falabellaStatus: null, falabellaError: null });
                await procesador.publicar(id, ['falabella'], { userId: 'u1', storeId: 's1' }, 'lote-1', {});
            }
        };
        return { procesador, agregar, publicados, items, sync, redis };
    };

    afterEach(() => { delete process.env.FALABELLA_BATCH_SIZE; });

    it('con tanda de 2, cada dos productos se envía una tanda sin esperar al final del lote', async () => {
        const { agregar, publicados } = construir('2');
        await agregar(5);
        expect(publicados).toEqual([['p1', 'p2'], ['p3', 'p4']]);
    });

    it('al cerrar el lote se manda lo que quedó, y cada producto queda enviado en la base', async () => {
        const { procesador, agregar, publicados, items } = construir('2');
        await agregar(5);
        expect(items.get('p5')!.falabellaStatus).toBe('pendiente');
        await procesador.publicarFalabellaDelLote('lote-1', ['falabella'], { userId: 'u1', storeId: 's1' }, {});
        expect(publicados).toEqual([['p1', 'p2'], ['p3', 'p4'], ['p5']]);
        expect([...items.values()].map((i) => i.falabellaStatus)).toEqual(['enviado', 'enviado', 'enviado', 'enviado', 'enviado']);
    });

    it('sin la variable no hay tandas: todo se manda junto al cerrar el lote, como siempre', async () => {
        const { procesador, agregar, publicados } = construir(undefined);
        await agregar(5);
        expect(publicados).toEqual([]);
        await procesador.publicarFalabellaDelLote('lote-1', ['falabella'], { userId: 'u1', storeId: 's1' }, {});
        expect(publicados).toHaveLength(1);
        expect(publicados[0].sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    });

    it('si Redis perdió la lista, el cierre del lote recupera los pendientes desde la base', async () => {
        const { procesador, agregar, publicados, redis } = construir(undefined);
        await agregar(3);
        redis.conjuntos.clear(); // Redis se reinició
        await procesador.publicarFalabellaDelLote('lote-1', ['falabella'], { userId: 'u1', storeId: 's1' }, {});
        expect(publicados[0].sort()).toEqual(['p1', 'p2', 'p3']);
    });

    it('un producto que Falabella rechaza queda anotado con su motivo; los demás, como enviados', async () => {
        const { procesador, agregar, items, sync } = construir('2');
        sync.publishBatchToFalabella.mockResolvedValueOnce({ enviados: 1, rechazados: [{ sku: 'SKU-2', nombre: 'x', motivo: 'la marca no existe en el catálogo de Falabella' }] });
        await agregar(2);
        expect(items.get('p1')).toMatchObject({ falabellaStatus: 'enviado', falabellaError: null });
        expect(items.get('p2')).toMatchObject({ falabellaStatus: 'rechazado', falabellaError: 'la marca no existe en el catálogo de Falabella' });
    });

    it('si el envío de una tanda falla, sus productos siguen pendientes y el cierre del lote los reintenta', async () => {
        const { procesador, agregar, items, sync, publicados } = construir('2');
        sync.publishBatchToFalabella.mockRejectedValueOnce(new Error('Falabella no responde'));
        await agregar(2);
        expect([...items.values()].map((i) => i.falabellaStatus)).toEqual(['pendiente', 'pendiente']);
        await procesador.publicarFalabellaDelLote('lote-1', ['falabella'], { userId: 'u1', storeId: 's1' }, {});
        expect(publicados[0].sort()).toEqual(['p1', 'p2']);
    });
});
