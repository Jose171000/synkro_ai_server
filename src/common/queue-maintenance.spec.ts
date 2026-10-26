import { limpiarCola, POLITICA_DE_LIMPIEZA } from './queue-maintenance.service';

/**
 * Redis se llenó porque el historial de trabajos terminados nunca se borraba. La limpieza borra por tandas lo viejo
 * (completados a la hora, fallidos a los tres días) y se detiene sola cuando no queda más.
 */
function colaConHistorial(completados: number, fallidos: number) {
    const restantes = { completed: completados, failed: fallidos };
    const llamadas: { tipo: string; gracia: number; limite: number }[] = [];
    return {
        llamadas,
        cola: {
            name: 'cola-de-prueba',
            clean: jest.fn(async (gracia: number, limite: number, tipo: 'completed' | 'failed') => {
                llamadas.push({ tipo, gracia, limite });
                const n = Math.min(limite, restantes[tipo]);
                restantes[tipo] -= n;
                return Array.from({ length: n }, (_, i) => String(i));
            }),
            trimEvents: jest.fn(async () => 0),
        },
    };
}

describe('limpiarCola', () => {
    const politica = { ...POLITICA_DE_LIMPIEZA, tanda: 100, maxTandas: 50 };

    it('borra todo el historial viejo por tandas y se detiene cuando ya no queda', async () => {
        const { cola, llamadas } = colaConHistorial(250, 30);
        const r = await limpiarCola(cola, politica);
        expect(r).toEqual({ completados: 250, fallidos: 30 });
        expect(llamadas.filter((l) => l.tipo === 'completed')).toHaveLength(3); // 100 + 100 + 50
        expect(llamadas.filter((l) => l.tipo === 'failed')).toHaveLength(1);
    });

    it('conserva los completados una hora y los fallidos tres días', async () => {
        const { cola, llamadas } = colaConHistorial(5, 5);
        await limpiarCola(cola, politica);
        expect(llamadas.find((l) => l.tipo === 'completed')!.gracia).toBe(60 * 60_000);
        expect(llamadas.find((l) => l.tipo === 'failed')!.gracia).toBe(3 * 24 * 3600_000);
    });

    it('con la cola ya limpia hace una sola consulta por tipo', async () => {
        const { cola, llamadas } = colaConHistorial(0, 0);
        expect(await limpiarCola(cola, politica)).toEqual({ completados: 0, fallidos: 0 });
        expect(llamadas).toHaveLength(2);
    });

    it('un historial enorme no ocupa la limpieza para siempre: se acota por vuelta', async () => {
        const { cola, llamadas } = colaConHistorial(1_000_000, 0);
        const r = await limpiarCola(cola, { ...politica, tanda: 100, maxTandas: 5 });
        expect(r.completados).toBe(500);
        expect(llamadas.filter((l) => l.tipo === 'completed')).toHaveLength(5);
    });

    it('acota también el historial de eventos', async () => {
        const { cola } = colaConHistorial(0, 0);
        await limpiarCola(cola, politica);
        expect(cola.trimEvents).toHaveBeenCalledWith(1_000);
    });
});
