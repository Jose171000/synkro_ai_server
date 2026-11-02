import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Estado de cada venta en palabras comunes a todos los canales (pendiente, enviado, entregado, cancelado, devuelto),
 * para poder filtrar y contar. Las ventas que ya existen se clasifican con lo que se guardó del canal; el estado de
 * Falabella se corrige solo en la siguiente consulta de ventas.
 */
export class EstadoDeVenta1790900000000 implements MigrationInterface {
    name = 'EstadoDeVenta1790900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "marketplace_orders" ADD "saleState" character varying(20) NOT NULL DEFAULT 'pendiente'`);
        await queryRunner.query(`
            UPDATE "marketplace_orders" SET "saleState" = CASE
                WHEN texto ~* '(return|devuel|refund|not_delivered|failed_delivery|undeliver)' THEN 'devuelto'
                WHEN texto ~* '(cancel|fail|rechaz)' THEN 'cancelado'
                WHEN texto ~* '(ready_to_ship|ready to ship|pending|handling)' THEN 'pendiente'
                WHEN texto ~* '(deliver|entreg|complet|closed)' THEN 'entregado'
                WHEN texto ~* '(ship|enviad|transit|dispatch|picked)' THEN 'enviado'
                ELSE 'pendiente' END
            FROM (
                SELECT id, COALESCE("details"->'shipping'->>'status', '') || ' ' || COALESCE("status", '') AS texto
                FROM "marketplace_orders"
            ) AS t
            WHERE "marketplace_orders".id = t.id`);
        await queryRunner.query(`CREATE INDEX "IDX_marketplace_orders_store_state" ON "marketplace_orders" ("storeId", "saleState")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_marketplace_orders_store_state"`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" DROP COLUMN "saleState"`);
    }
}
