import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Detalle de cada venta: número de pedido, cliente, fecha máxima de despacho
 * y un bloque con envío, pago y notas en formato común a todos los canales.
 *
 * Son columnas opcionales y nacen vacías. Las ventas ya guardadas se
 * completan solas la próxima vez que el canal las devuelva.
 */
export class DetalleDeVentas1789200000000 implements MigrationInterface {
    name = 'DetalleDeVentas1789200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "marketplace_orders" ADD "orderNumber" character varying`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" ADD "customerName" character varying`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" ADD "shipByDate" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" ADD "details" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "marketplace_orders" DROP COLUMN "details"`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" DROP COLUMN "shipByDate"`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" DROP COLUMN "customerName"`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" DROP COLUMN "orderNumber"`);
    }

}
