import { MigrationInterface, QueryRunner } from "typeorm";

/** El nombre del Excel de cada carga masiva, para reconocerla en el historial. Las cargas anteriores quedan sin él. */
export class NombreDeArchivoDeCarga1792100000000 implements MigrationInterface {
    name = 'NombreDeArchivoDeCarga1792100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "bulk_batches" ADD "fileName" character varying(200)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "bulk_batches" DROP COLUMN "fileName"`);
    }
}
