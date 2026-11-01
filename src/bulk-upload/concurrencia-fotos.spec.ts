import { allSettledConLimite, concurrenciaDeFotos } from './concurrencia-fotos';

describe('concurrencia de la subida de fotos', () => {
    it('sin variable o con un valor que no sirve no hay límite, como siempre', () => {
        for (const v of [undefined, '', '  ', 'abc', '0', '-3', '2.5', '8 a la vez']) {
            expect(concurrenciaDeFotos(v)).toBe(0);
        }
    });

    it('toma el número que se le da y tiene un tope', () => {
        expect(concurrenciaDeFotos(' 8 ')).toBe(8);
        expect(concurrenciaDeFotos('500')).toBe(50);
    });
});

describe('allSettledConLimite', () => {
    const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('nunca tiene más tareas en curso que el límite y conserva el orden', async () => {
        let enCurso = 0;
        let maximo = 0;
        const r = await allSettledConLimite([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
            enCurso++;
            maximo = Math.max(maximo, enCurso);
            await espera(5);
            enCurso--;
            return n * 10;
        });
        expect(maximo).toBe(3);
        expect(r.map((x) => (x as any).value)).toEqual([10, 20, 30, 40, 50, 60, 70]);
    });

    it('una tarea que falla no detiene a las demás y se informa en su lugar', async () => {
        const r = await allSettledConLimite(['a', 'b', 'c'], 2, async (x) => {
            if (x === 'b') throw new Error('mala foto');
            return x;
        });
        expect(r.map((x) => x.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
        expect((r[1] as PromiseRejectedResult).reason.message).toBe('mala foto');
    });

    it('con límite 0 (o mayor que la lista) corren todas a la vez, como antes', async () => {
        let enCurso = 0;
        let maximo = 0;
        const tarea = async () => { enCurso++; maximo = Math.max(maximo, enCurso); await espera(5); enCurso--; };
        await allSettledConLimite([1, 2, 3, 4], 0, tarea);
        expect(maximo).toBe(4);
        maximo = 0;
        await allSettledConLimite([1, 2, 3, 4], 10, tarea);
        expect(maximo).toBe(4);
    });

    it('con una lista vacía devuelve una lista vacía', async () => {
        expect(await allSettledConLimite([], 3, async () => 1)).toEqual([]);
    });
});
