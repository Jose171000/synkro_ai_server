import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Pausa de una publicación hecha por el usuario desde Synkro: mientras dura no se envían stock ni precio al canal.
 */
export class PausaDeCanal1790400000000 implements MigrationInterface {
    name = 'PausaDeCanal1790400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "listing_links" ADD "pausedByUser" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "listing_links" DROP COLUMN "pausedByUser"`);
    }
}
