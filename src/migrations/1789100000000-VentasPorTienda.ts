import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Las ventas pasan a pertenecer a una tienda y a la cuenta del canal por la
 * que entraron, para que cada tienda tenga sus propias analíticas.
 *
 * Las ventas que ya existen se asignan a la cuenta (y por tanto a la tienda)
 * de su dueño en ese canal; si ya no hay cuenta, a la tienda más antigua del
 * dueño. Nada se borra ni cambia de importe.
 */
export class VentasPorTienda1789100000000 implements MigrationInterface {
    name = 'VentasPorTienda1789100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "marketplace_orders" ADD "storeId" uuid`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" ADD "connectionId" uuid`);

        await queryRunner.query(`
            UPDATE "marketplace_orders" o SET "connectionId" = (
                SELECT c."id" FROM "marketplace_connections" c
                WHERE c."marketplace" = o."marketplace" AND c."ownerId" = o."ownerId"
                ORDER BY c."createdAt" ASC LIMIT 1
            )
        `);
        await queryRunner.query(`
            UPDATE "marketplace_orders" o SET "storeId" = c."storeId"
            FROM "marketplace_connections" c WHERE c."id" = o."connectionId"
        `);
        await queryRunner.query(`
            UPDATE "marketplace_orders" o SET "storeId" = (
                SELECT s."id" FROM "stores" s WHERE s."ownerId" = o."ownerId" ORDER BY s."createdAt" ASC LIMIT 1
            ) WHERE o."storeId" IS NULL
        `);

        await queryRunner.query(`ALTER TABLE "marketplace_orders" ADD CONSTRAINT "FK_order_store" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" ADD CONSTRAINT "FK_order_connection" FOREIGN KEY ("connectionId") REFERENCES "marketplace_connections"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`CREATE INDEX "IDX_order_store_date" ON "marketplace_orders" ("storeId", "orderDate")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_order_store_date"`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" DROP CONSTRAINT "FK_order_connection"`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" DROP CONSTRAINT "FK_order_store"`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" DROP COLUMN "connectionId"`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" DROP COLUMN "storeId"`);
    }

}
