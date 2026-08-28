import {
    buildSignedQuery,
    buildStringToSign,
    falabellaTimestamp,
    rfc3986Encode,
    signParams,
} from './falabella-signature';

/**
 * El ejemplo oficial de Falabella publica la cadena exacta que debe firmarse.
 * Es el patrón contra el que se comprueba la parte que más se rompe.
 * Docs: https://developers.falabella.com/docs/signing-requests
 */
const EJEMPLO_OFICIAL = {
    params: {
        Action: 'FeedList',
        Format: 'XML',
        Timestamp: '2015-07-01T11:11:11+00:00',
        UserID: 'test@example.com',
        Version: '1.0',
    },
    cadenaEsperada:
        'Action=FeedList&Format=XML&Timestamp=2015-07-01T11%3A11%3A11%2B00%3A00&UserID=test%40example.com&Version=1.0',
};

describe('firma de Falabella', () => {
    it('reproduce exactamente la cadena del ejemplo oficial', () => {
        expect(buildStringToSign(EJEMPLO_OFICIAL.params)).toBe(EJEMPLO_OFICIAL.cadenaEsperada);
    });

    it('ordena los parámetros por nombre, no por el orden en que llegan', () => {
        const desordenado = {
            Version: '1.0',
            UserID: 'test@example.com',
            Action: 'FeedList',
            Timestamp: '2015-07-01T11:11:11+00:00',
            Format: 'XML',
        };
        expect(buildStringToSign(desordenado)).toBe(EJEMPLO_OFICIAL.cadenaEsperada);
    });

    it('nunca incluye Signature en el cálculo', () => {
        const conFirma = { ...EJEMPLO_OFICIAL.params, Signature: 'loquesea' };
        expect(buildStringToSign(conFirma)).toBe(EJEMPLO_OFICIAL.cadenaEsperada);
    });

    describe('codificación RFC 3986', () => {
        it('codifica los caracteres que encodeURIComponent deja pasar', () => {
            // Aquí es donde una implementación ingenua se rompe en silencio.
            expect(rfc3986Encode("!'()*")).toBe('%21%27%28%29%2A');
        });

        it('deja intactos los caracteres no reservados', () => {
            expect(rfc3986Encode("Abc-123_x.y~z")).toBe('Abc-123_x.y~z');
        });

        it('codifica dos puntos, más y arroba como en el ejemplo', () => {
            expect(rfc3986Encode('2015-07-01T11:11:11+00:00')).toBe('2015-07-01T11%3A11%3A11%2B00%3A00');
            expect(rfc3986Encode('test@example.com')).toBe('test%40example.com');
        });

        it('codifica espacios y acentos de un nombre de producto real', () => {
            expect(rfc3986Encode('Camisa Algodón (talla M)')).toBe('Camisa%20Algod%C3%B3n%20%28talla%20M%29');
        });
    });

    describe('marca de tiempo', () => {
        it('usa ISO8601 con zona horaria y sin milisegundos', () => {
            expect(falabellaTimestamp(new Date('2015-07-01T11:11:11.000Z'))).toBe('2015-07-01T11:11:11+00:00');
        });

        it('coincide con el formato del ejemplo oficial', () => {
            expect(falabellaTimestamp()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
        });
    });

    describe('firma', () => {
        it('es HMAC-SHA256 en hexadecimal de 64 caracteres', () => {
            const firma = signParams(EJEMPLO_OFICIAL.params, 'una-api-key');
            expect(firma).toMatch(/^[0-9a-f]{64}$/);
        });

        it('cambia si cambia la clave', () => {
            expect(signParams(EJEMPLO_OFICIAL.params, 'clave-a'))
                .not.toBe(signParams(EJEMPLO_OFICIAL.params, 'clave-b'));
        });

        it('cambia si cambia cualquier parámetro', () => {
            const otro = { ...EJEMPLO_OFICIAL.params, Action: 'GetOrders' };
            expect(signParams(EJEMPLO_OFICIAL.params, 'k')).not.toBe(signParams(otro, 'k'));
        });

        it('la query firmada añade Signature al final y conserva la cadena', () => {
            const query = buildSignedQuery(EJEMPLO_OFICIAL.params, 'k');
            expect(query.startsWith(EJEMPLO_OFICIAL.cadenaEsperada + '&Signature=')).toBe(true);
            expect(query.split('&Signature=')[1]).toMatch(/^[0-9a-f]{64}$/);
        });
    });
});
