/**
 * Cifra las credenciales de marketplaces que sigan guardadas en texto plano.
 *
 *   npm run credentials:check     → solo informa, no escribe nada
 *   npm run credentials:encrypt   → cifra
 *
 * El servidor ya hace esto solo al arrancar; este script existe para poder
 * comprobarlo a mano o migrar una base de datos concreta. Se puede ejecutar
 * las veces que haga falta: lo que ya está cifrado se salta.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { backfillMarketplaceCredentials } from '../common/crypto/credentials-backfill';
import { getEncryptionKey } from '../common/crypto/credentials-crypto';

async function main(): Promise<void> {
    const dryRun = process.argv.includes('--check');

    // Falla aquí, y no a mitad de la migración, si la clave no está configurada.
    getEncryptionKey();

    const client = new Client({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 5432),
        user: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });

    await client.connect();
    console.log(`Conectado a "${process.env.DB_NAME}" en ${process.env.DB_HOST}`);
    console.log(dryRun ? 'Modo comprobación: no se escribirá nada.\n' : 'Migrando...\n');

    try {
        const result = await backfillMarketplaceCredentials(
            async (sql, params) => (await client.query(sql, params)).rows,
            { dryRun },
        );

        if (result.total === 0) {
            console.log('No hay conexiones guardadas. Nada que migrar.');
            return;
        }

        result.details.forEach(line => console.log(`  ${line}`));
        console.log('');

        if (dryRun) {
            console.log(
                result.migrated === 0
                    ? `Todo en orden: las ${result.total} conexiones están cifradas.`
                    : `${result.migrated} de ${result.total} conexiones siguen en texto plano. ` +
                      `Ejecuta "npm run credentials:encrypt" para cifrarlas.`,
            );
        } else {
            console.log(`Listo: ${result.migrated} cifradas, ${result.alreadyEncrypted} ya lo estaban.`);
        }
    } finally {
        await client.end();
    }
}

main().catch(error => {
    console.error(`\nLa migración falló: ${error?.message}`);
    process.exit(1);
});
