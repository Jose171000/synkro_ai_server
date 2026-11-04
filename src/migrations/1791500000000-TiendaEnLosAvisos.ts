import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Cada aviso de la campana guarda la tienda a la que corresponde, para mostrar su nombre y llevar a ella con un clic.
 * Los avisos que ya existen se completan con la tienda de su producto o, si no, la de su cuenta de canal; los demás quedan sin
 * tienda (se muestran igual, sin nombre).
 */
export class TiendaEnLosAvisos1791500000000 implements MigrationInterface {
    name = 'TiendaEnLosAvisos1791500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notifications" ADD "storeId" uuid`);
        await queryRunner.query(`ALTER TABLE "notifications" ADD CONSTRAINT "FK_notifications_store" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`
            UPDATE "notifications" n SET "storeId" = p."storeId"
            FROM "products" p
            WHERE n."storeId" IS NULL AND n."meta" ->> 'productId' = p."id"::text AND p."storeId" IS NOT NULL
        `);
        await queryRunner.query(`
            UPDATE "notifications" n SET "storeId" = c."storeId"
            FROM "marketplace_connections" c
            WHERE n."storeId" IS NULL AND n."meta" ->> 'connectionId' = c."id"::text AND c."storeId" IS NOT NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notifications" DROP CONSTRAINT "FK_notifications_store"`);
        await queryRunner.query(`ALTER TABLE "notifications" DROP COLUMN "storeId"`);
    }
}
