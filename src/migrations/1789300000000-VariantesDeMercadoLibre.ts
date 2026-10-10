import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Mercado Libre maneja el stock y el precio por variante. Cada publicación
 * enlazada recuerda a qué variante corresponde, para actualizar la correcta.
 * Opcional y vacía en lo que ya existe: ninguna publicación actual cambia.
 */
export class VariantesDeMercadoLibre1789300000000 implements MigrationInterface {
    name = 'VariantesDeMercadoLibre1789300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "listing_links" ADD "variationId" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "listing_links" DROP COLUMN "variationId"`);
    }

}
