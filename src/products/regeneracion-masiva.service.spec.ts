import { RegeneracionMasivaService } from './regeneracion-masiva.service';

const prod = (id: string, over: any = {}) => ({ id, sku: 'SKU-' + id, name: 'Producto ' + id, aiTitle: null, group: null, createdAt: new Date(), ...over });
const grupo = (id: string) => ({ id, name: 'Grupo ' + id, parentSku: 'GP-' + id });

function armar(existentes: any[]) {
    const repo = { find: jest.fn(async () => existentes), count: jest.fn(async (o: any) => existentes.filter((p) => p.group?.id === o.where.group.id).length) };
    const products = { generateAIContent: jest.fn(async () => ({ llenado: ['ficha HTML', '3 atributos'] })) };
    const groups = { regenerarContenido: jest.fn(async () => ({ variantes: 3, titulo: 't', llenado: ['descripción'] })) };
    const guardado = new Map<string, string>();
    const redis = {
        set: jest.fn(async (k: string, v: string) => { guardado.set(k, v); return 'OK'; }),
        get: jest.fn(async (k: string) => guardado.get(k) ?? null),
    };
    const servicio = new RegeneracionMasivaService(repo as any, products as any, groups as any, redis as any);
    return { servicio, repo, products, groups, redis };
}
const ambito = { userId: 'u1', storeId: 's1' };
const esperar = async (servicio: RegeneracionMasivaService, id: string) => {
    for (let i = 0; i < 100; i++) {
        const e = await servicio.estado(ambito, id);
        if (e.terminado) return e;
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('no terminó');
};

describe('RegeneracionMasivaService', () => {
    const antes = { ...process.env };
    afterEach(() => { process.env = { ...antes }; });

    it('un producto suelto se regenera «solo lo vacío» y dice qué llenó', async () => {
        const { servicio, products } = armar([prod('a')]);
        const lote = await servicio.iniciar(ambito, ['a'], { tone: 'amigable' });
        expect(lote.items).toHaveLength(1);
        expect(lote.items[0].estado).toBe('en_cola');
        const fin = await esperar(servicio, lote.id);
        expect(products.generateAIContent).toHaveBeenCalledWith('a', 'u1', { tone: 'amigable', marketplaces: undefined, soloVacio: true }, 's1');
        expect(fin.items[0]).toMatchObject({ estado: 'listo', mensaje: 'Llené: ficha HTML, 3 atributos.' });
        expect(fin).toMatchObject({ total: 1, terminados: 1, terminado: true });
    });

    it('las variantes de un grupo se regeneran UNA sola vez, con el grupo como una fila', async () => {
        const g = grupo('G1');
        const { servicio, groups, products } = armar([prod('v1', { group: g }), prod('v2', { group: g }), prod('v3', { group: g }), prod('s1')]);
        const lote = await servicio.iniciar(ambito, ['v1', 'v2', 'v3', 's1']);
        expect(lote.items.map((i) => i.clave)).toEqual(['g:G1', 'p:s1']);
        expect(lote.items[0]).toMatchObject({ etiqueta: 'Grupo G1', sku: 'GP-G1', variantes: 3 });
        const fin = await esperar(servicio, lote.id);
        expect(groups.regenerarContenido).toHaveBeenCalledTimes(1);
        expect(groups.regenerarContenido).toHaveBeenCalledWith('G1', { tone: undefined, marketplaces: undefined, soloVacio: true }, ambito);
        expect(products.generateAIContent).toHaveBeenCalledTimes(1);
        expect(fin.items[0].mensaje).toBe('Llené: descripción (en las 3 variantes).');
    });

    it('si solo se marca una variante, el grupo cuenta con todas las que tiene', async () => {
        const g = grupo('G1');
        const { servicio, repo } = armar([prod('v1', { group: g }), prod('v2', { group: g }), prod('v3', { group: g })]);
        repo.find.mockResolvedValueOnce([prod('v1', { group: g })] as any); // se marcó solo una
        const lote = await servicio.iniciar(ambito, ['v1']);
        expect(lote.items[0].variantes).toBe(3);
    });

    it('si no había nada vacío, queda «sin cambios»', async () => {
        const { servicio, products } = armar([prod('a')]);
        products.generateAIContent.mockResolvedValueOnce({ llenado: [] } as any);
        const lote = await servicio.iniciar(ambito, ['a']);
        const fin = await esperar(servicio, lote.id);
        expect(fin.items[0]).toMatchObject({ estado: 'sin_cambios' });
    });

    it('un error en uno no frena a los demás y se muestra el motivo', async () => {
        const { servicio, products } = armar([prod('a'), prod('b')]);
        products.generateAIContent.mockRejectedValueOnce(new Error('La IA no respondió'));
        const lote = await servicio.iniciar(ambito, ['a', 'b']);
        const fin = await esperar(servicio, lote.id);
        expect(fin.items.map((i) => i.estado).sort()).toEqual(['error', 'listo']);
        expect(fin.items.find((i) => i.estado === 'error')!.mensaje).toBe('La IA no respondió');
    });

    it('pasado el tope por tanda se rechaza, contando los grupos como uno', async () => {
        process.env.REGEN_IA_MAX_POR_TANDA = '2';
        const g = grupo('G1');
        const ok = armar([prod('v1', { group: g }), prod('v2', { group: g }), prod('s1')]);
        await expect(ok.servicio.iniciar(ambito, ['v1', 'v2', 's1'])).resolves.toBeDefined(); // 2 filas: cabe
        const mucho = armar([prod('a'), prod('b'), prod('c')]);
        await expect(mucho.servicio.iniciar(ambito, ['a', 'b', 'c'])).rejects.toThrow(/máximo por tanda es 2/);
        expect(mucho.products.generateAIContent).not.toHaveBeenCalled();
    });

    it('nunca corren más generaciones a la vez que la concurrencia configurada', async () => {
        process.env.REGEN_IA_CONCURRENCIA = '2';
        const { servicio, products } = armar(['a', 'b', 'c', 'd', 'e'].map((i) => prod(i)));
        let activas = 0; let maximo = 0;
        products.generateAIContent.mockImplementation((async () => {
            activas++; maximo = Math.max(maximo, activas);
            await new Promise((r) => setTimeout(r, 15));
            activas--;
            return { llenado: ['título'] };
        }) as any);
        const lote = await servicio.iniciar(ambito, ['a', 'b', 'c', 'd', 'e']);
        await esperar(servicio, lote.id);
        expect(maximo).toBe(2);
    });

    it('no deja lanzar otra tanda en la misma tienda mientras una sigue corriendo', async () => {
        const { servicio, products } = armar([prod('a')]);
        let soltar: () => void = () => undefined;
        products.generateAIContent.mockImplementation((() => new Promise((r) => { soltar = () => r({ llenado: ['título'] }); })) as any);
        const lote = await servicio.iniciar(ambito, ['a']);
        await expect(servicio.iniciar(ambito, ['a'])).rejects.toThrow(/en curso/);
        soltar();
        await esperar(servicio, lote.id);
        await expect(servicio.iniciar(ambito, ['a'])).resolves.toBeDefined();
    });

    it('el estado de una tanda es solo de su tienda; sin tanda es 404', async () => {
        const { servicio } = armar([prod('a')]);
        const lote = await servicio.iniciar(ambito, ['a']);
        await expect(servicio.estado({ userId: 'x', storeId: 'otra' }, lote.id)).rejects.toThrow(/No se encontró/);
        await expect(servicio.estado(ambito, 'no-existe')).rejects.toThrow(/No se encontró/);
    });

    it('si el servidor se reinició, lo que quedó a medias aparece como interrumpido', async () => {
        const { servicio, redis } = armar([prod('a')]);
        const hace = Date.now() - 30 * 60_000;
        await redis.set('regen-ia:viejo', JSON.stringify({ id: 'viejo', storeId: 's1', userId: 'u1', creado: hace, items: [{ clave: 'p:a', productId: 'a', grupoId: null, sku: 'A', etiqueta: 'A', variantes: 1, estado: 'generando', mensaje: null, actualizado: hace }] }));
        const e = await servicio.estado(ambito, 'viejo');
        expect(e.items[0]).toMatchObject({ estado: 'error' });
        expect(e.items[0].mensaje).toMatch(/interrumpió/);
        expect(e.terminado).toBe(true);
    });

    it('sin selección o sin productos de la tienda se rechaza', async () => {
        const { servicio } = armar([]);
        await expect(servicio.iniciar(ambito, [])).rejects.toThrow(/al menos un producto/);
        await expect(servicio.iniciar(ambito, ['zzz'])).rejects.toThrow(/No se encontró ninguno/);
    });
});
