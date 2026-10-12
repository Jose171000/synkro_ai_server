import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Las cuentas que se registran por su cuenta esperan la aprobación de un
 * superadmin antes de poder entrar. Todas las que ya existen quedan aprobadas:
 * nadie pierde el acceso.
 */
export class AprobacionDeCuentas1790000000000 implements MigrationInterface {
    name = 'AprobacionDeCuentas1790000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD "approvalStatus" character varying(20) NOT NULL DEFAULT 'approved'`);
        await queryRunner.query(`ALTER TABLE "users" ADD "approvalNote" text`);
        await queryRunner.query(`ALTER TABLE "users" ADD "approvedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`CREATE INDEX "IDX_users_approvalStatus" ON "users" ("approvalStatus")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_users_approvalStatus"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "approvedAt"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "approvalNote"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "approvalStatus"`);
    }
}
