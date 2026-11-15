import { MeliApiService } from './meli-api.service';

/** La consulta por lotes de Mercado Libre puede responder «403 Resource deprecated»: entonces se piden una por una. */
function armar() {
    const api: any = new MeliApiService();
    api.http = { get: jest.fn() };
    return api;
}
const error = (status: number) => Object.assign(new Error(`status ${status}`), { response: { status } });
const lote = (ids: string[]) => ids.map((id) => ({ code: 200, body: { id } }));

describe('MeliApiService.getItems', () => {
    it('con la consulta por lotes funcionando, usa lotes de 20', async () => {
        const api = armar();
        api.http.get.mockResolvedValue({ data: lote(['A', 'B']) });
        const r = await api.getItems('tok', ['A', 'B']);
        expect(api.http.get).toHaveBeenCalledTimes(1);
        expect(api.http.get).toHaveBeenCalledWith('/items', expect.objectContaining({ params: { ids: 'A,B' } }));
        expect(r.items.map((i: any) => i.id)).toEqual(['A', 'B']);
    });

    it('si el lote da 403, pide cada publicación una por una y sigue con los demás lotes', async () => {
        const api = armar();
        const ids = Array.from({ length: 25 }, (_, i) => `MPE${i}`);
        api.http.get.mockImplementation(async (url: string, opts: any) => {
            if (url === '/items' && opts.params.ids.startsWith('MPE0,')) throw error(403); // el primer lote falla
            if (url === '/items') return { data: lote(opts.params.ids.split(',')) };
            return { data: { id: url.replace('/items/', '') } };
        });
        const r = await api.getItems('tok', ids);
        expect(r.items).toHaveLength(25);
        const sueltas = api.http.get.mock.calls.filter((c: any[]) => c[0] !== '/items');
        expect(sueltas).toHaveLength(20); // solo las del lote que falló
        expect(r.notFound).toEqual([]);
    });

    it('en la lectura una por una, un 404 es «no existe» y otro error se informa', async () => {
        const api = armar();
        api.http.get.mockImplementation(async (url: string) => {
            if (url === '/items') throw error(403);
            if (url === '/items/MPE2') throw error(404);
            return { data: { id: url.replace('/items/', '') } };
        });
        const r = await api.getItems('tok', ['MPE1', 'MPE2']);
        expect(r.items.map((i: any) => i.id)).toEqual(['MPE1']);
        expect(r.notFound).toEqual(['MPE2']);

        const mala = armar();
        mala.http.get.mockImplementation(async (url: string) => { throw error(url === '/items' ? 403 : 500); });
        await expect(mala.getItems('tok', ['MPE1'])).rejects.toThrow(/500/);
    });

    it('un error distinto de 403 en el lote no se disfraza: se informa', async () => {
        const api = armar();
        api.http.get.mockRejectedValue(error(500));
        await expect(api.getItems('tok', ['A'])).rejects.toThrow(/500/);
        expect(api.http.get).toHaveBeenCalledTimes(1);
    });
});
