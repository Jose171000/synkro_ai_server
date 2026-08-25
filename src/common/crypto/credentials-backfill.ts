import { encryptSecret, isEncrypted } from './credentials-crypto';

/**
 * Migración de las credenciales que quedaron guardadas en texto plano antes
 * de que existiera el cifrado.
 *
 * La lógica vive aquí, separada de cómo se llega a la base de datos, para que
 * la use tanto el arranque del servidor (a través de TypeORM) como el script
 * manual `npm run credentials:encrypt` (a través del cliente de Postgres).
 *
 * Es idempotente: lo que ya está cifrado se salta. Y es seguro aunque dos
 * instancias arranquen a la vez — ambas escribirían un cifrado válido del
 * mismo valor original.
 */

/** Ejecuta SQL y devuelve las filas. Cada entorno pasa su propio adaptador. */
export type QueryFn = (sql: string, params?: any[]) => Promise<any[]>;

const SECRET_FIELDS = ['accessToken', 'refreshToken', 'secrets'] as const;

export interface BackfillResult {
    total: number;
    migrated: number;
    alreadyEncrypted: number;
    details: string[];
}

export async function backfillMarketplaceCredentials(
    query: QueryFn,
    options: { dryRun?: boolean } = {},
): Promise<BackfillResult> {
    const rows = await query(
        `SELECT id, marketplace, "externalNickname", "accessToken", "refreshToken", "secrets"
         FROM marketplace_connections
         ORDER BY "createdAt"`,
    );

    const result: BackfillResult = {
        total: rows.length,
        migrated: 0,
        alreadyEncrypted: 0,
        details: [],
    };

    for (const row of rows) {
        const label = `${row.marketplace}${row.externalNickname ? ` (${row.externalNickname})` : ''}`;
        const plainFields = SECRET_FIELDS.filter(
            field => row[field] && !isEncrypted(row[field] as string),
        );

        if (plainFields.length === 0) {
            result.alreadyEncrypted++;
            result.details.push(`${label}: ya estaba cifrada.`);
            continue;
        }

        if (!options.dryRun) {
            const sets = plainFields.map((field, i) => `"${field}" = $${i + 2}`).join(', ');
            const values = plainFields.map(field => encryptSecret(row[field] as string));
            await query(`UPDATE marketplace_connections SET ${sets} WHERE id = $1`, [row.id, ...values]);
        }

        result.migrated++;
        result.details.push(
            options.dryRun
                ? `${label}: EN TEXTO PLANO → ${plainFields.join(', ')}`
                : `${label}: cifrada (${plainFields.join(', ')}).`,
        );
    }

    return result;
}
