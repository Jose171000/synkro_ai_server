import { MigrationInterface, QueryRunner } from "typeorm";

export class Notifications1787943440749 implements MigrationInterface {
    name = 'Notifications1787943440749'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "notifications" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "type" character varying(20) NOT NULL, "severity" character varying(10) NOT NULL DEFAULT 'info', "title" character varying NOT NULL, "body" text NOT NULL, "marketplace" character varying, "meta" jsonb, "read" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "ownerId" uuid, CONSTRAINT "PK_6a72c3c0f683f6462415e653c3a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_866f0bd65900b078e0c39e3c11" ON "notifications" ("ownerId", "read") `);
        await queryRunner.query(`ALTER TABLE "notifications" ADD CONSTRAINT "FK_59ca06b1bcf1ad63cb253f2965c" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notifications" DROP CONSTRAINT "FK_59ca06b1bcf1ad63cb253f2965c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_866f0bd65900b078e0c39e3c11"`);
        await queryRunner.query(`DROP TABLE "notifications"`);
    }

}
