import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Cada publicación guarda lo que muestra su canal (precio regular, precio con
 * descuento, imagen y variante) y cada producto puede tener un precio web.
 *
 * Todas las columnas son opcionales y nacen vacías: nada de lo guardado
 * cambia. Se rellenan la próxima vez que se importe el catálogo de Falabella.
 */
export class PreciosImagenYPrecioWeb1788800000000 implements MigrationInterface {
    name = 'PreciosImagenYPrecioWeb1788800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "listing_links" ADD "regularPrice" numeric(10,2)`);
        await queryRunner.query(`ALTER TABLE "listing_links" ADD "salePrice" numeric(10,2)`);
        await queryRunner.query(`ALTER TABLE "listing_links" ADD "imageUrl" text`);
        await queryRunner.query(`ALTER TABLE "listing_links" ADD "variation" character varying`);
        await queryRunner.query(`ALTER TABLE "listing_links" ADD "parentSku" character varying`);
        await queryRunner.query(`ALTER TABLE "products" ADD "webPrice" numeric(10,2)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "webPrice"`);
        await queryRunner.query(`ALTER TABLE "listing_links" DROP COLUMN "parentSku"`);
        await queryRunner.query(`ALTER TABLE "listing_links" DROP COLUMN "variation"`);
        await queryRunner.query(`ALTER TABLE "listing_links" DROP COLUMN "imageUrl"`);
        await queryRunner.query(`ALTER TABLE "listing_links" DROP COLUMN "salePrice"`);
        await queryRunner.query(`ALTER TABLE "listing_links" DROP COLUMN "regularPrice"`);
    }

}
