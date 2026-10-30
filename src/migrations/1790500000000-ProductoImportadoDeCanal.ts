import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * De qué canal se importó un producto (falabella, mercadolibre, woocommerce, shopify). Nulo en los que se crearon en
 * Synkro. Se muestra en la ficha del producto; no cambia nada de lo que se publica.
 */
export class ProductoImportadoDeCanal1790500000000 implements MigrationInterface {
    name = 'ProductoImportadoDeCanal1790500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "products" ADD "importedFrom" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "importedFrom"`);
    }
}
