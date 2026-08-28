import { createHmac } from 'crypto';

/**
 * Firma de las peticiones al Seller Center de Falabella.
 *
 * Falabella no usa OAuth ni una cabecera con la clave: cada petición viaja
 * firmada. Se ordenan todos los parámetros por nombre, se codifican según
 * RFC 3986, se concatenan como `nombre=valor` separados por `&`, y esa cadena
 * se firma con HMAC-SHA256 usando la API key del vendedor. El resultado en
 * hexadecimal se añade como un parámetro más, `Signature`.
 *
 * Está en su propio archivo porque es la pieza más frágil de la integración:
 * un solo carácter mal codificado y Falabella rechaza TODAS las peticiones
 * con un error que no explica por qué. Así se puede probar aislada, contra el
 * ejemplo publicado en su documentación.
 *
 * Docs: https://developers.falabella.com/docs/signing-requests
 */

/**
 * Codifica según RFC 3986, que es lo que hace `rawurlencode()` de PHP —
 * el lenguaje del ejemplo oficial.
 *
 * `encodeURIComponent` de JavaScript casi coincide, pero deja sin codificar
 * `!`, `'`, `(`, `)` y `*`, que RFC 3986 sí exige codificar. Sin este ajuste
 * la firma sale distinta en cuanto un valor lleve alguno de esos caracteres
 * (por ejemplo, el nombre de un producto).
 */
export function rfc3986Encode(value: string): string {
    return encodeURIComponent(value).replace(
        /[!'()*]/g,
        char => '%' + char.charCodeAt(0).toString(16).toUpperCase(),
    );
}

/**
 * Marca de tiempo en ISO8601 con zona horaria, como pide la API
 * (`2015-07-01T11:11:11+00:00`). `toISOString()` termina en `Z` y trae
 * milisegundos, que aquí sobran.
 */
export function falabellaTimestamp(date: Date = new Date()): string {
    return date.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/**
 * Construye la cadena que se firma: parámetros ordenados por nombre,
 * codificados, y unidos. `Signature` nunca entra en el cálculo.
 */
export function buildStringToSign(params: Record<string, string | number>): string {
    return Object.keys(params)
        .filter(name => name !== 'Signature')
        .sort()
        .map(name => `${rfc3986Encode(name)}=${rfc3986Encode(String(params[name]))}`)
        .join('&');
}

/** Firma HMAC-SHA256 en hexadecimal. */
export function signParams(params: Record<string, string | number>, apiKey: string): string {
    return createHmac('sha256', apiKey).update(buildStringToSign(params), 'utf8').digest('hex');
}

/**
 * Devuelve la query string completa y firmada, lista para pegar a la URL.
 * La firma se añade al final; el orden en la URL no importa, solo el orden
 * usado para calcularla.
 */
export function buildSignedQuery(params: Record<string, string | number>, apiKey: string): string {
    const signature = signParams(params, apiKey);
    return `${buildStringToSign(params)}&Signature=${rfc3986Encode(signature)}`;
}
