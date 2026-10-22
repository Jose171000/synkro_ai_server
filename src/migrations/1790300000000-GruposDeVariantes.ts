import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Productos con variantes: un grupo (`product_groups`) con sus ejes, y cada variante sigue siendo un producto que apunta
 * al grupo. Los productos actuales no se tocan: sin grupo son un producto simple, como siempre.
 */
export class GruposDeVariantes1790300000000 implements MigrationInterface {
    name = 'GruposDeVariantes1790300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "product_groups" (
            "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
            "name" character varying NOT NULL,
            "parentSku" character varying NOT NULL,
            "axes" jsonb NOT NULL DEFAULT '[]',
            "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
            "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
            "ownerId" uuid,
            "storeId" uuid,
            CONSTRAINT "PK_product_groups" PRIMARY KEY ("id")
        )`);
        await queryRunner.query(`ALTER TABLE "product_groups" ADD CONSTRAINT "FK_product_groups_owner" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "product_groups" ADD CONSTRAINT "FK_product_groups_store" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        // El código del grupo es único dentro de la tienda, sin distinguir mayúsculas ni espacios.
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_group_parentsku_store" ON "product_groups" ("storeId", lower(btrim("parentSku"))) WHERE "storeId" IS NOT NULL`);

        await queryRunner.query(`ALTER TABLE "products" ADD "groupId" uuid`);
        await queryRunner.query(`ALTER TABLE "products" ADD "variantValues" jsonb`);
        await queryRunner.query(`ALTER TABLE "products" ADD CONSTRAINT "FK_products_group" FOREIGN KEY ("groupId") REFERENCES "product_groups"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`CREATE INDEX "IDX_products_group" ON "products" ("groupId")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_products_group"`);
        await queryRunner.query(`ALTER TABLE "products" DROP CONSTRAINT "FK_products_group"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "variantValues"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "groupId"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_group_parentsku_store"`);
        await queryRunner.query(`ALTER TABLE "product_groups" DROP CONSTRAINT "FK_product_groups_store"`);
        await queryRunner.query(`ALTER TABLE "product_groups" DROP CONSTRAINT "FK_product_groups_owner"`);
        await queryRunner.query(`DROP TABLE "product_groups"`);
    }
}
