import { atributosRechazadosPorMeli, sinAtributosRechazados } from './atributos-rechazados';

const ERROR_REAL = 'Validation error — El valor que ingresaste en "Resistencia de la memoria" es incorrecto.; El valor que ingresaste en "Velocidad máxima de lectura SSD" es incorrecto.; Attribute MEMORY_RESISTANCE with value 240 TBW was omitted. Invalid attribute: translation not found for es in {es_pe=240.0}; Attribute SSD_MAX_READ_SPEED with value 550 MB/s was omitted. Invalid attribute: translation not found for es in {es_pe=550.0}; Attribute SSD_MAX_WRITE_SPEED with value 500 MB/s was omitted.';

describe('atributos que Mercado Libre rechaza', () => {
    it('saca del mensaje real los atributos omitidos, sin repetirlos', () => {
        expect(atributosRechazadosPorMeli(ERROR_REAL)).toEqual(['MEMORY_RESISTANCE', 'SSD_MAX_READ_SPEED', 'SSD_MAX_WRITE_SPEED']);
    });

    it('nunca propone quitar los que identifican al producto', () => {
        expect(atributosRechazadosPorMeli('Attribute BRAND with value X was omitted. Attribute COLOR with value Y was omitted. Attribute SELLER_SKU with value Z was omitted.')).toEqual([]);
    });

    it('un error que no habla de atributos no quita nada', () => {
        expect(atributosRechazadosPorMeli('invalid_token')).toEqual([]);
        expect(atributosRechazadosPorMeli('')).toEqual([]);
    });

    it('quita solo los rechazados y dice cuáles', () => {
        const attrs = [{ id: 'BRAND', value_name: 'PNY' }, { id: 'MEMORY_RESISTANCE', value_name: '240 TBW' }, { id: 'LINE', value_name: 'CS900' }];
        const r = sinAtributosRechazados(attrs, ['MEMORY_RESISTANCE', 'OTRO']);
        expect(r.atributos.map((a) => a.id)).toEqual(['BRAND', 'LINE']);
        expect(r.quitados).toEqual(['MEMORY_RESISTANCE']);
    });
});
