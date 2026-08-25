import { Logger } from '@nestjs/common';
import { ValueTransformer } from 'typeorm';
import { decryptSecret, encryptSecret } from './credentials-crypto';

const logger = new Logger('EncryptedColumn');

/**
 * Transformadores de columna: TypeORM los aplica al escribir y al leer, así
 * que las credenciales viajan cifradas hacia la base de datos y llegan
 * descifradas al código de negocio sin que ningún servicio tenga que
 * acordarse de hacerlo. Cualquier integración futura (Yavendió, Falabella)
 * hereda la protección con solo declarar la columna con este transformador.
 */

function isEmpty(value: unknown): boolean {
    return value === null || value === undefined || value === '';
}

/**
 * Si el descifrado falla —clave equivocada, valor manipulado— NO tumbamos la
 * consulta entera: se registra el problema y la credencial llega como null.
 * Quien la use la tratará como una conexión rota y pedirá reconectar, en vez
 * de responder un error 500 en toda la pantalla de Marketplaces.
 */
function safeDecrypt(value: string): string | null {
    try {
        return decryptSecret(value);
    } catch (error: any) {
        logger.error(
            `No se pudo descifrar una credencial guardada: ${error?.message}. ` +
            `Revisa que CREDENTIALS_ENCRYPTION_KEY sea la misma con la que se guardó.`,
        );
        return null;
    }
}

/** Columna de texto que se guarda cifrada. */
export const encryptedTextTransformer: ValueTransformer = {
    to: (value?: string | null) => (isEmpty(value) ? value : encryptSecret(value as string)),
    from: (value?: string | null) => (isEmpty(value) ? value : safeDecrypt(value as string)),
};

/**
 * Columna que guarda un objeto arbitrario (cifrado). Pensada para las
 * integraciones que no usan OAuth sino credenciales que el cliente pega a
 * mano: la API key de Yavendió, el UserID + API key de Falabella, etc.
 */
export const encryptedJsonTransformer: ValueTransformer = {
    to: (value?: Record<string, any> | null) =>
        value === null || value === undefined ? value : encryptSecret(JSON.stringify(value)),
    from: (value?: string | null) => {
        if (isEmpty(value)) return null;
        const plain = safeDecrypt(value as string);
        if (plain === null) return null;
        try {
            return JSON.parse(plain);
        } catch {
            logger.error('Una credencial descifrada no contenía JSON válido.');
            return null;
        }
    },
};
