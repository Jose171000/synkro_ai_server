import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Plan comercial de cada cliente: cómo se le cobra (cuota fija, comisión sobre
 * ventas o ambos), cuánto y cuándo vence el próximo pago. Todo es opcional y
 * arranca como «ninguno»: ningún cliente actual cambia hasta que se le defina.
 */
export class PlanComercialDelCliente1789500000000 implements MigrationInterface {
    name = 'PlanComercialDelCliente1789500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "client_profiles" ADD "billingModel" character varying(20) NOT NULL DEFAULT 'ninguno'`);
        await queryRunner.query(`ALTER TABLE "client_profiles" ADD "monthlyFee" numeric(12,2)`);
        await queryRunner.query(`ALTER TABLE "client_profiles" ADD "feeFrequency" character varying(20) NOT NULL DEFAULT 'mensual'`);
        await queryRunner.query(`ALTER TABLE "client_profiles" ADD "commissionRate" numeric(6,3)`);
        await queryRunner.query(`ALTER TABLE "client_profiles" ADD "nextDueDate" date`);
        await queryRunner.query(`ALTER TABLE "client_profiles" ADD "planCurrency" character varying(5) NOT NULL DEFAULT 'PEN'`);
        await queryRunner.query(`ALTER TABLE "client_profiles" ADD "proposalNotes" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "client_profiles" DROP COLUMN "proposalNotes"`);
        await queryRunner.query(`ALTER TABLE "client_profiles" DROP COLUMN "planCurrency"`);
        await queryRunner.query(`ALTER TABLE "client_profiles" DROP COLUMN "nextDueDate"`);
        await queryRunner.query(`ALTER TABLE "client_profiles" DROP COLUMN "commissionRate"`);
        await queryRunner.query(`ALTER TABLE "client_profiles" DROP COLUMN "feeFrequency"`);
        await queryRunner.query(`ALTER TABLE "client_profiles" DROP COLUMN "monthlyFee"`);
        await queryRunner.query(`ALTER TABLE "client_profiles" DROP COLUMN "billingModel"`);
    }
}
