import { conectarRegistroDeUso, conUsoIa, FilaDeUso, medirUso, precioDe, usoDeRespuesta } from './uso-ia';

describe('uso de IA: costo por tokens', () => {
    it('calcula el costo de gpt-4o-mini con caché de OpenAI', () => {
        const r = usoDeRespuesta('gpt-4o-mini', { prompt_tokens: 12000, completion_tokens: 600, prompt_tokens_details: { cached_tokens: 2000 } });
        // 10000 * 0.15 + 2000 * 0.075 + 600 * 0.6 = 1500 + 150 + 360 = 2010 → 0.00201
        expect(r.costUsd).toBeCloseTo(0.00201, 6);
        expect(r).toMatchObject({ promptTokens: 12000, cachedTokens: 2000, completionTokens: 600, priceKnown: true });
    });

    it('lee los aciertos de caché de DeepSeek', () => {
        const r = usoDeRespuesta('deepseek-chat', { prompt_tokens: 10000, completion_tokens: 1000, prompt_cache_hit_tokens: 4000, prompt_cache_miss_tokens: 6000 });
        expect(r.costUsd).toBeCloseTo((6000 * 0.14 + 4000 * 0.0028 + 1000 * 0.28) / 1e6, 8);
    });

    it('un modelo sin tarifa guarda los tokens y marca el costo como desconocido', () => {
        const r = usoDeRespuesta('modelo-nuevo', { prompt_tokens: 100, completion_tokens: 50 });
        expect(r).toMatchObject({ costUsd: 0, priceKnown: false, promptTokens: 100, completionTokens: 50 });
    });

    it('reconoce versiones con fecha y permite sobrescribir la tarifa', () => {
        expect(precioDe('gpt-4o-mini-2024-07-18')).toEqual(precioDe('gpt-4o-mini'));
        expect(precioDe('gpt-4o-mini', '{"gpt-4o-mini":{"entrada":1,"cache":1,"salida":1}}')?.entrada).toBe(1);
        expect(precioDe('gpt-4o-mini', '{no es json')?.entrada).toBe(0.15);
    });

    it('una respuesta sin usage no rompe', () => {
        expect(usoDeRespuesta('gpt-4o-mini', undefined).costUsd).toBe(0);
    });
});

describe('uso de IA: contexto y medición', () => {
    const filas: FilaDeUso[] = [];
    beforeEach(() => { filas.length = 0; conectarRegistroDeUso((f) => filas.push(f)); });
    afterAll(() => conectarRegistroDeUso(null));

    const falso = () => ({
        chat: { completions: { create: async (_: any) => ({ usage: { prompt_tokens: 1000, completion_tokens: 100 } }) } },
        embeddings: { create: async (_: any) => ({ usage: { prompt_tokens: 50, total_tokens: 50 } }) },
    });

    it('anota el usuario y la ejecución de quien abrió el contexto, aunque haya esperas', async () => {
        const c = medirUso(falso(), 'openai');
        await conUsoIa({ userId: 'u1', operacion: 'generar-producto' }, async () => {
            await c.chat.completions.create({ model: 'gpt-4o-mini' });
            await new Promise((r) => setTimeout(r, 5));
            await c.embeddings.create({ model: 'text-embedding-3-small' });
        });
        await new Promise((r) => setImmediate(r));
        expect(filas).toHaveLength(2);
        expect(filas.every((f) => f.userId === 'u1' && f.operation === 'generar-producto')).toBe(true);
        expect(filas[0].runId).toBeTruthy();
        expect(filas[0].runId).toBe(filas[1].runId);
    });

    it('dos usuarios al mismo tiempo no se mezclan y cada producto es una ejecución distinta', async () => {
        const c = medirUso(falso(), 'openai');
        await Promise.all(['a', 'b'].map((u) => conUsoIa({ userId: u, operacion: 'generar-producto' }, async () => {
            await new Promise((r) => setTimeout(r, u === 'a' ? 10 : 1));
            await c.chat.completions.create({ model: 'gpt-4o-mini' });
        })));
        await new Promise((r) => setImmediate(r));
        expect(filas.map((f) => f.userId).sort()).toEqual(['a', 'b']);
        expect(new Set(filas.map((f) => f.runId)).size).toBe(2);
    });

    it('una operación interna hereda al usuario y una llamada sin contexto queda sin asignar', async () => {
        const c = medirUso(falso(), 'openai');
        await conUsoIa({ userId: 'u1', operacion: 'preparar-falabella' }, () => conUsoIa({ operacion: 'otra' }, () => c.chat.completions.create({ model: 'gpt-4o-mini' })));
        await c.chat.completions.create({ model: 'gpt-4o-mini' });
        await new Promise((r) => setImmediate(r));
        expect(filas[0]).toMatchObject({ userId: 'u1', operation: 'otra' });
        expect(filas[1]).toMatchObject({ userId: null, operation: 'sin-operacion' });
    });

    it('medir dos veces el mismo cliente no duplica el registro', async () => {
        const c = medirUso(medirUso(falso(), 'openai'), 'openai');
        await c.chat.completions.create({ model: 'gpt-4o-mini' });
        await new Promise((r) => setImmediate(r));
        expect(filas).toHaveLength(1);
    });

    it('si el registro falla, la llamada de IA igual responde', async () => {
        conectarRegistroDeUso(() => { throw new Error('boom'); });
        const c = medirUso(falso(), 'openai');
        await expect(c.chat.completions.create({ model: 'gpt-4o-mini' })).resolves.toBeTruthy();
    });
});
