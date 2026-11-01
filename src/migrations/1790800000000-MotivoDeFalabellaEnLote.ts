import { MigrationInterface, QueryRunner } from "typeorm";

/** Por qué Falabella no aceptó un producto de una carga masiva (nulo si lo aceptó o aún no se envió). */
export class MotivoDeFalabellaEnLote1790800000000 implements MigrationInterface {
    name = 'MotivoDeFalabellaEnLote1790800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "bulk_batch_items" ADD "falabellaError" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "bulk_batch_items" DROP COLUMN "falabellaError"`);
    }
}
