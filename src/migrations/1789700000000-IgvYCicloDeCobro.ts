import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * El plan de cada cliente indica si la cuota y la comisión pactadas ya incluyen
 * IGV o si el IGV va aparte, y desde cuándo rige (para contar las ventas del
 * ciclo de cobro). Por defecto el IGV va aparte, que es lo habitual al cotizar.
 */
export class IgvYCicloDeCobro1789700000000 implements MigrationInterface {
    name = 'IgvYCicloDeCobro1789700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "client_profiles" ADD "feeIncludesIgv" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "client_profiles" ADD "commissionIncludesIgv" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "client_profiles" ADD "planStartDate" date`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "client_profiles" DROP COLUMN "planStartDate"`);
        await queryRunner.query(`ALTER TABLE "client_profiles" DROP COLUMN "commissionIncludesIgv"`);
        await queryRunner.query(`ALTER TABLE "client_profiles" DROP COLUMN "feeIncludesIgv"`);
    }
}
