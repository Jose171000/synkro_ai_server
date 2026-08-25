import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Cifrado de credenciales en reposo.
 *
 * Los tokens de OAuth y las API keys que el cliente pega a mano son la llave
 * de su cuenta en el marketplace. Guardarlos en texto plano significa que
 * cualquiera con una copia de la base de datos (un backup, un volcado, un
 * acceso mal configurado) puede operar las cuentas de todos los clientes.
 *
 * Aquí se cifran con AES-256-GCM: además de ocultar el contenido, GCM añade
 * una etiqueta de autenticidad, así que un valor manipulado en la base de
 * datos falla al descifrarse en vez de devolver basura silenciosamente.
 *
 * Formato del sobre (todo en una sola columna de texto):
 *   enc.v1.<iv en base64>.<tag en base64>.<texto cifrado en base64>
 *
 * El prefijo cumple dos funciones: identifica la versión del esquema (por si
 * algún día hay que cambiar de algoritmo) y permite distinguir un valor ya
 * cifrado de uno heredado en texto plano, que es lo que hace posible migrar
 * sin cortar la conexión de Mercado Libre que ya está funcionando.
 */

const ENVELOPE_PREFIX = 'enc.v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // tamaño recomendado para GCM
const KEY_BYTES = 32; // AES-256

const KEY_ENV_VAR = 'CREDENTIALS_ENCRYPTION_KEY';

const MISSING_KEY_MESSAGE =
    `Falta la variable de entorno ${KEY_ENV_VAR}. Sin ella no se pueden leer ni ` +
    `guardar las credenciales de los marketplaces. Genera una con: ` +
    `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`;

let cachedKey: Buffer | null = null;

/** Acepta la clave en hexadecimal (64 caracteres) o en base64 (32 bytes). */
function decodeKey(raw: string): Buffer {
    const trimmed = raw.trim();
    if (/^[0-9a-f]{64}$/i.test(trimmed)) {
        return Buffer.from(trimmed, 'hex');
    }
    return Buffer.from(trimmed, 'base64');
}

export function getEncryptionKey(): Buffer {
    if (cachedKey) return cachedKey;

    const raw = process.env[KEY_ENV_VAR];
    if (!raw || !raw.trim()) {
        throw new Error(MISSING_KEY_MESSAGE);
    }

    const key = decodeKey(raw);
    if (key.length !== KEY_BYTES) {
        throw new Error(
            `${KEY_ENV_VAR} debe representar 32 bytes (64 caracteres hexadecimales o ` +
            `44 caracteres en base64); se recibieron ${key.length} bytes.`,
        );
    }

    cachedKey = key;
    return key;
}

/** Solo para los tests: olvida la clave memorizada tras cambiar el entorno. */
export function resetEncryptionKeyCache(): void {
    cachedKey = null;
}

/** ¿Este valor ya está cifrado con nuestro sobre? */
export function isEncrypted(value: string): boolean {
    return typeof value === 'string' && value.startsWith(`${ENVELOPE_PREFIX}.`);
}

/** Cifra un texto. Si ya venía cifrado lo devuelve tal cual (idempotente). */
export function encryptSecret(plainText: string): string {
    if (isEncrypted(plainText)) return plainText;

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, getEncryptionKey(), iv);
    const cipherText = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
        ENVELOPE_PREFIX,
        iv.toString('base64'),
        tag.toString('base64'),
        cipherText.toString('base64'),
    ].join('.');
}

/**
 * Descifra un valor. Los valores heredados en texto plano (los que ya estaban
 * en la base antes de esta migración) se devuelven sin tocar, para que las
 * conexiones existentes sigan funcionando mientras se migran.
 */
export function decryptSecret(value: string): string {
    if (!isEncrypted(value)) return value;

    // enc . v1 . iv . tag . textoCifrado  → 5 trozos (el prefijo lleva punto).
    // El base64 nunca contiene puntos, así que separar por '.' es seguro.
    const parts = value.split('.');
    if (parts.length !== 5) {
        throw new Error('Credencial cifrada con formato inválido.');
    }

    const [, , ivB64, tagB64, cipherTextB64] = parts;
    const decipher = createDecipheriv(ALGORITHM, getEncryptionKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

    return Buffer.concat([
        decipher.update(Buffer.from(cipherTextB64, 'base64')),
        decipher.final(),
    ]).toString('utf8');
}
