import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Precio con descuento y fechas de vigencia del producto, que se envían a Falabella (SpecialPrice,
 * SpecialFromDate, SpecialToDate), y registro de la promoción que ya se mandó a cada canal.
 */
export class DescuentoDeProducto1790100000000 implements MigrationInterface {
    name = 'DescuentoDeProducto1790100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "products" ADD "salePrice" numeric(10,2)`);
        await queryRunner.query(`ALTER TABLE "products" ADD "saleStartDate" date`);
        await queryRunner.query(`ALTER TABLE "products" ADD "saleEndDate" date`);
        await queryRunner.query(`ALTER TABLE "listing_links" ADD "lastPromoSynced" character varying(80)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "listing_links" DROP COLUMN "lastPromoSynced"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "saleEndDate"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "saleStartDate"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "salePrice"`);
    }
}
