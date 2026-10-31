import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Precio y descuento propios de cada canal. Todas las columnas nacen vacías: un enlace sin valores propios
 * sigue usando el precio y el descuento del producto, como hasta ahora.
 */
export class PreciosPorCanal1790600000000 implements MigrationInterface {
    name = 'PreciosPorCanal1790600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "listing_links" ADD "priceOverride" numeric(10,2)`);
        await queryRunner.query(`ALTER TABLE "listing_links" ADD "salePriceOverride" numeric(10,2)`);
        await queryRunner.query(`ALTER TABLE "listing_links" ADD "saleStartOverride" date`);
        await queryRunner.query(`ALTER TABLE "listing_links" ADD "saleEndOverride" date`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "listing_links" DROP COLUMN "saleEndOverride"`);
        await queryRunner.query(`ALTER TABLE "listing_links" DROP COLUMN "saleStartOverride"`);
        await queryRunner.query(`ALTER TABLE "listing_links" DROP COLUMN "salePriceOverride"`);
        await queryRunner.query(`ALTER TABLE "listing_links" DROP COLUMN "priceOverride"`);
    }
}
