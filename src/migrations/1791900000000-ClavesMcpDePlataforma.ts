import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Claves del MCP de plataforma (docs/mcp.md): las que usa un superadmin para consultar toda la agencia, no una tienda.
 *
 * `kind` distingue las de tienda («store», las que ya existían) de las de plataforma («platform»). Una clave de plataforma no
 * pertenece a ninguna tienda, así que `storeId` pasa a poder ser nulo; el CHECK asegura que una clave de tienda siempre tenga
 * tienda y una de plataforma nunca. Las claves que ya existen quedan como «store», sin cambios.
 */
export class ClavesMcpDePlataforma1791900000000 implements MigrationInterface {
    name = 'ClavesMcpDePlataforma1791900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "store_api_keys" ADD "kind" character varying(10) NOT NULL DEFAULT 'store'`);
        await queryRunner.query(`ALTER TABLE "store_api_keys" ALTER COLUMN "storeId" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "store_api_keys" ADD CONSTRAINT "CHK_store_api_keys_kind" CHECK (
            ("kind" = 'store' AND "storeId" IS NOT NULL) OR ("kind" = 'platform' AND "storeId" IS NULL)
        )`);
        await queryRunner.query(`CREATE INDEX "IDX_store_api_keys_kind" ON "store_api_keys" ("kind")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Las claves de plataforma no caben en el esquema anterior (sin tienda): se borran al deshacer.
        await queryRunner.query(`DELETE FROM "store_api_keys" WHERE "kind" = 'platform'`);
        await queryRunner.query(`DROP INDEX "IDX_store_api_keys_kind"`);
        await queryRunner.query(`ALTER TABLE "store_api_keys" DROP CONSTRAINT "CHK_store_api_keys_kind"`);
        await queryRunner.query(`ALTER TABLE "store_api_keys" ALTER COLUMN "storeId" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "store_api_keys" DROP COLUMN "kind"`);
    }
}
