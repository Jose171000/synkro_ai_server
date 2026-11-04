import { ventaAnteriorALaConexion } from './venta-anterior-a-la-conexion';

describe('venta anterior a la conexión de la cuenta', () => {
    const conectada = new Date('2026-11-04T15:00:00Z');

    it('una venta de antes de conectar es historia', () => {
        expect(ventaAnteriorALaConexion({ createdAt: conectada }, new Date('2026-11-03T10:00:00Z'))).toBe(true);
    });

    it('una venta de después de conectar es nueva', () => {
        expect(ventaAnteriorALaConexion({ createdAt: conectada }, new Date('2026-11-04T15:00:01Z'))).toBe(false);
    });

    it('acepta fechas como texto', () => {
        expect(ventaAnteriorALaConexion({ createdAt: '2026-11-04T15:00:00Z' }, '2026-11-01T00:00:00Z')).toBe(true);
    });

    it('sin una de las dos fechas, o con una fecha inválida, se trata como nueva (lo de siempre)', () => {
        expect(ventaAnteriorALaConexion({}, new Date())).toBe(false);
        expect(ventaAnteriorALaConexion(null, new Date())).toBe(false);
        expect(ventaAnteriorALaConexion({ createdAt: conectada }, null)).toBe(false);
        expect(ventaAnteriorALaConexion({ createdAt: conectada }, 'no es una fecha')).toBe(false);
    });
});
