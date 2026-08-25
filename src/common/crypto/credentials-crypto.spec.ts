import { randomBytes } from 'crypto';
import {
    decryptSecret,
    encryptSecret,
    getEncryptionKey,
    isEncrypted,
    resetEncryptionKeyCache,
} from './credentials-crypto';
import { encryptedJsonTransformer, encryptedTextTransformer } from './encrypted-column.transformer';
import { backfillMarketplaceCredentials } from './credentials-backfill';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

function useKey(key: string | undefined): void {
    if (key === undefined) {
        delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    } else {
        process.env.CREDENTIALS_ENCRYPTION_KEY = key;
    }
    resetEncryptionKeyCache();
}

describe('credentials-crypto', () => {
    beforeEach(() => useKey(KEY_A));
    afterAll(() => useKey(undefined));

    it('devuelve el mismo texto tras cifrar y descifrar', () => {
        const token = 'APP_USR-126180521922188-070815-abc123';
        const encrypted = encryptSecret(token);

        expect(encrypted).not.toContain(token);
        expect(isEncrypted(encrypted)).toBe(true);
        expect(decryptSecret(encrypted)).toBe(token);
    });

    it('produce un cifrado distinto cada vez para el mismo texto', () => {
        // Cada cifrado usa un IV nuevo: dos filas con el mismo token no
        // se ven iguales en la base de datos.
        expect(encryptSecret('mismo-token')).not.toBe(encryptSecret('mismo-token'));
    });

    it('no vuelve a cifrar un valor ya cifrado', () => {
        const once = encryptSecret('token');
        expect(encryptSecret(once)).toBe(once);
    });

    it('deja pasar los valores heredados en texto plano', () => {
        // Es lo que permite migrar sin cortar la conexión de Mercado Libre.
        expect(decryptSecret('TG-6a57f2454b3bd40001f8a')).toBe('TG-6a57f2454b3bd40001f8a');
    });

    it('rechaza un valor manipulado en la base de datos', () => {
        const encrypted = encryptSecret('token-real');
        const parts = encrypted.split('.');
        const tampered = [...parts.slice(0, 3), Buffer.from('otro-token').toString('base64')].join('.');

        expect(() => decryptSecret(tampered)).toThrow();
    });

    it('falla al descifrar con otra clave', () => {
        const encrypted = encryptSecret('token');
        useKey(KEY_B);
        expect(() => decryptSecret(encrypted)).toThrow();
    });

    it('acepta la clave en hexadecimal y en base64, y rechaza tamaños inválidos', () => {
        useKey(randomBytes(32).toString('hex'));
        expect(getEncryptionKey()).toHaveLength(32);

        useKey(randomBytes(16).toString('base64'));
        expect(() => getEncryptionKey()).toThrow(/32 bytes/);
    });

    it('explica qué hacer si falta la clave', () => {
        useKey(undefined);
        expect(() => encryptSecret('x')).toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
    });
});

describe('transformadores de columna', () => {
    beforeEach(() => useKey(KEY_A));
    afterAll(() => useKey(undefined));

    it('cifra al guardar y descifra al leer', () => {
        const stored = encryptedTextTransformer.to('mi-token');
        expect(stored).not.toBe('mi-token');
        expect(encryptedTextTransformer.from(stored)).toBe('mi-token');
    });

    it('deja null y cadena vacía sin tocar', () => {
        for (const empty of [null, undefined, '']) {
            expect(encryptedTextTransformer.to(empty as any)).toBe(empty);
            expect(encryptedTextTransformer.from(empty as any)).toBe(empty);
        }
    });

    it('devuelve null en vez de romper si la credencial no se puede descifrar', () => {
        const stored = encryptedTextTransformer.to('mi-token');
        useKey(KEY_B);
        expect(encryptedTextTransformer.from(stored)).toBeNull();
    });

    it('guarda objetos completos cifrados (API keys de Yavendió / Falabella)', () => {
        const secrets = { apiKey: 'yv_live_v1_abc', userId: 'seller@synkroai.com' };
        const stored = encryptedJsonTransformer.to(secrets);

        expect(String(stored)).not.toContain('yv_live_v1_abc');
        expect(encryptedJsonTransformer.from(stored)).toEqual(secrets);
    });
});

describe('migración de credenciales existentes', () => {
    beforeEach(() => useKey(KEY_A));
    afterAll(() => useKey(undefined));

    /** Base de datos de mentira: guarda filas y aplica los UPDATE del backfill. */
    function fakeDb(rows: any[]) {
        const updates: string[] = [];
        const query = async (sql: string, params?: any[]) => {
            if (sql.trim().startsWith('SELECT')) return rows;
            updates.push(sql);
            const row = rows.find(r => r.id === params![0]);
            const fields = [...sql.matchAll(/"(\w+)" = \$/g)].map(m => m[1]);
            fields.forEach((field, i) => { row[field] = params![i + 1]; });
            return [];
        };
        return { query, updates };
    }

    it('cifra las filas en texto plano y deja intactas las ya cifradas', async () => {
        const rows: any[] = [
            {
                id: '1', marketplace: 'mercadolibre', externalNickname: 'II2025',
                accessToken: 'APP_USR-plano', refreshToken: 'TG-plano', secrets: null,
            },
            {
                id: '2', marketplace: 'yavendio', externalNickname: null,
                accessToken: encryptSecret('yv_live_v1_ya_cifrada'), refreshToken: null, secrets: null,
            },
        ];
        const db = fakeDb(rows);

        const result = await backfillMarketplaceCredentials(db.query);

        expect(result).toMatchObject({ total: 2, migrated: 1, alreadyEncrypted: 1 });
        expect(isEncrypted(rows[0].accessToken)).toBe(true);
        expect(decryptSecret(rows[0].accessToken)).toBe('APP_USR-plano');
        expect(decryptSecret(rows[0].refreshToken)).toBe('TG-plano');
        expect(db.updates).toHaveLength(1); // la fila ya cifrada no se reescribe
    });

    it('ejecutarla dos veces no cambia nada la segunda vez', async () => {
        const rows = [{
            id: '1', marketplace: 'mercadolibre', externalNickname: null,
            accessToken: 'APP_USR-plano', refreshToken: null, secrets: null,
        }];
        const db = fakeDb(rows);

        await backfillMarketplaceCredentials(db.query);
        const second = await backfillMarketplaceCredentials(db.query);

        expect(second).toMatchObject({ migrated: 0, alreadyEncrypted: 1 });
        expect(db.updates).toHaveLength(1);
    });

    it('en modo comprobación no escribe nada', async () => {
        const rows = [{
            id: '1', marketplace: 'mercadolibre', externalNickname: null,
            accessToken: 'APP_USR-plano', refreshToken: null, secrets: null,
        }];
        const db = fakeDb(rows);

        const result = await backfillMarketplaceCredentials(db.query, { dryRun: true });

        expect(result.migrated).toBe(1);
        expect(db.updates).toHaveLength(0);
        expect(rows[0].accessToken).toBe('APP_USR-plano');
    });
});
