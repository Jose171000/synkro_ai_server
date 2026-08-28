import { MigrationInterface, QueryRunner } from "typeorm";

export class YavendioConnections1787871088154 implements MigrationInterface {
    name = 'YavendioConnections1787871088154'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "marketplace_connections" ALTER COLUMN "expiresAt" DROP NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "marketplace_connections" ALTER COLUMN "expiresAt" SET NOT NULL`);
    }

}
