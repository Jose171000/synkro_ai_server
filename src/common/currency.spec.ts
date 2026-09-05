import {
    MONEDA_POR_PAIS,
    monedaDePais,
    monedaPorDefecto,
    normalizarMoneda,
    resolverMoneda,
} from './currency';

describe('moneda de la cuenta', () => {
    const original = process.env.DEFAULT_CURRENCY;

    afterEach(() => {
        if (original === undefined) delete process.env.DEFAULT_CURRENCY;
        else process.env.DEFAULT_CURRENCY = original;
    });

    describe('normalizarMoneda', () => {
        it('acepta un código de tres letras y lo pone en mayúsculas', () => {
            expect(normalizarMoneda('cop')).toBe('COP');
            expect(normalizarMoneda('  pen  ')).toBe('PEN');
        });

        it('rechaza lo que no parezca un código de moneda', () => {
            // Si un marketplace manda basura en ese campo preferimos caer al
            // siguiente escalón antes que guardar un valor inventado.
            expect(normalizarMoneda('soles')).toBeUndefined();
            expect(normalizarMoneda('')).toBeUndefined();
            expect(normalizarMoneda(null)).toBeUndefined();
            expect(normalizarMoneda(123)).toBeUndefined();
            expect(normalizarMoneda(undefined)).toBeUndefined();
        });
    });

    describe('monedaDePais', () => {
        it('conoce los países donde opera Falabella', () => {
            expect(monedaDePais('PE')).toBe('PEN');
            expect(monedaDePais('CL')).toBe('CLP');
            expect(monedaDePais('CO')).toBe('COP');
        });

        it('no distingue mayúsculas ni espacios', () => {
            expect(monedaDePais(' co ')).toBe('COP');
        });

        it('devuelve indefinido para un país que no conocemos', () => {
            expect(monedaDePais('ZZ')).toBeUndefined();
            expect(monedaDePais(null)).toBeUndefined();
        });

        it('todas las monedas del mapa son códigos válidos', () => {
            for (const [pais, moneda] of Object.entries(MONEDA_POR_PAIS)) {
                expect(pais).toMatch(/^[A-Z]{2}$/);
                expect(normalizarMoneda(moneda)).toBe(moneda);
            }
        });
    });

    describe('resolverMoneda', () => {
        it('gana el primer candidato válido', () => {
            expect(resolverMoneda('COP', 'PEN')).toBe('COP');
        });

        it('se salta los candidatos vacíos o inválidos', () => {
            expect(resolverMoneda(null, undefined, 'soles', 'CLP')).toBe('CLP');
        });

        it('cae a la moneda por defecto si no hay ninguno válido', () => {
            process.env.DEFAULT_CURRENCY = 'COP';
            expect(resolverMoneda(null, undefined)).toBe('COP');
        });

        it('usa soles si no se configuró nada', () => {
            // Compatibilidad: es lo que hacía el código antes de este cambio.
            delete process.env.DEFAULT_CURRENCY;
            expect(resolverMoneda(null)).toBe('PEN');
            expect(monedaPorDefecto()).toBe('PEN');
        });

        it('ignora una moneda por defecto mal escrita', () => {
            process.env.DEFAULT_CURRENCY = 'pesos colombianos';
            expect(monedaPorDefecto()).toBe('PEN');
        });

        it('el caso real: pedido de Falabella Colombia sin moneda en la respuesta', () => {
            // Falabella usa la misma API para PE, CL y CO. Antes esto se
            // guardaba como 'PEN' y la facturación del cliente salía mal.
            const pedido: any = { AddressShipping: { Country: 'CO' } };
            const monedaGuardadaAlConectar = 'COP';

            expect(
                resolverMoneda(
                    pedido.Currency,
                    monedaDePais(pedido.AddressShipping?.Country),
                    monedaGuardadaAlConectar,
                ),
            ).toBe('COP');
        });
    });
});
