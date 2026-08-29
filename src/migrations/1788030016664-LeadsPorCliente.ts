import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Da dueño a los prospectos del CRM.
 *
 * Hasta ahora los leads eran una lista única y global: valía mientras el CRM
 * era solo del administrador, pero impedía que cada cliente viera los suyos.
 *
 * El orden importa. La columna se añade opcional, se rellenan las filas que
 * ya existen y solo entonces se vuelve obligatoria. Al revés, Postgres
 * rechazaría la migración en cuanto hubiera un solo lead guardado — y en
 * producción hay cientos.
 */
export class LeadsPorCliente1788030016664 implements MigrationInterface {
    name = 'LeadsPorCliente1788030016664'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leads" ADD "ownerId" uuid`);

        const pendientes = await queryRunner.query(
            `SELECT COUNT(*)::int AS n FROM "leads" WHERE "ownerId" IS NULL`,
        );

        if (Number(pendientes[0]?.n ?? 0) > 0) {
            // Los leads que ya existen se importaron desde Yavendió con la
            // cuenta del administrador, así que su dueño es ese administrador.
            // Se busca por los datos y no por un id escrito a mano, para que
            // la migración sea correcta también en local y en cualquier copia.
            const candidatos = await queryRunner.query(`
                SELECT u.id
                FROM "users" u
                LEFT JOIN "marketplace_connections" mc
                       ON mc."ownerId" = u.id AND mc.marketplace = 'yavendio'
                WHERE u.role = 'admin'
                ORDER BY (mc.id IS NOT NULL) DESC, u."createdAt" ASC
                LIMIT 1
            `);

            const duenoId = candidatos[0]?.id;
            if (!duenoId) {
                throw new Error(
                    'Hay prospectos en el CRM pero ningún administrador al que asignárselos. ' +
                    'Revisa la tabla users antes de aplicar esta migración.',
                );
            }

            await queryRunner.query(
                `UPDATE "leads" SET "ownerId" = $1 WHERE "ownerId" IS NULL`,
                [duenoId],
            );
        }

        await queryRunner.query(`ALTER TABLE "leads" ALTER COLUMN "ownerId" SET NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_d673803d4443e1bfe47d11c45b" ON "leads" ("ownerId") `);
        await queryRunner.query(`ALTER TABLE "leads" ADD CONSTRAINT "FK_d673803d4443e1bfe47d11c45be" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leads" DROP CONSTRAINT "FK_d673803d4443e1bfe47d11c45be"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d673803d4443e1bfe47d11c45b"`);
        await queryRunner.query(`ALTER TABLE "leads" DROP COLUMN "ownerId"`);
    }

}
