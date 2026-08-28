import { MigrationInterface, QueryRunner } from "typeorm";

export class FalabellaFeedsAndPackaging1787940699699 implements MigrationInterface {
    name = 'FalabellaFeedsAndPackaging1787940699699'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "marketplace_feeds" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "marketplace" character varying NOT NULL DEFAULT 'falabella', "externalFeedId" character varying NOT NULL, "action" character varying NOT NULL, "skus" text, "status" character varying NOT NULL DEFAULT 'pending', "totalRecords" integer NOT NULL DEFAULT '0', "processedRecords" integer NOT NULL DEFAULT '0', "failedRecords" integer NOT NULL DEFAULT '0', "errors" jsonb, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "ownerId" uuid, CONSTRAINT "PK_301d281eda4bfd122d49c1cd624" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2faddef0e1eb52ec87206ca4f7" ON "marketplace_feeds" ("externalFeedId") `);
        await queryRunner.query(`ALTER TABLE "products" ADD "packageWidth" integer`);
        await queryRunner.query(`ALTER TABLE "products" ADD "packageLength" integer`);
        await queryRunner.query(`ALTER TABLE "products" ADD "packageHeight" integer`);
        await queryRunner.query(`ALTER TABLE "products" ADD "packageWeight" numeric(8,3)`);
        await queryRunner.query(`ALTER TABLE "marketplace_feeds" ADD CONSTRAINT "FK_9c9b555d7d6a7cfcf9fb7fce9e3" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "marketplace_feeds" DROP CONSTRAINT "FK_9c9b555d7d6a7cfcf9fb7fce9e3"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "packageWeight"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "packageHeight"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "packageLength"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "packageWidth"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2faddef0e1eb52ec87206ca4f7"`);
        await queryRunner.query(`DROP TABLE "marketplace_feeds"`);
    }

}
