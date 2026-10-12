import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * La comisión de los clientes se calcula sobre lo que pagó el comprador solo
 * por los productos, sin envío ni otros cargos. Cada venta guarda ese importe
 * en `productsAmount`. Las ya guardadas se calculan de sus líneas (cantidad x
 * precio pagado); si una venta no trae líneas con precio, se usa su total.
 */
export class ImporteDeProductosPorVenta1789600000000 implements MigrationInterface {
    name = 'ImporteDeProductosPorVenta1789600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "marketplace_orders" ADD "productsAmount" numeric(12,2)`);
        await queryRunner.query(`
            UPDATE "marketplace_orders" o
            SET "productsAmount" = COALESCE((
                SELECT NULLIF(ROUND(SUM(
                    CASE WHEN COALESCE(it->>'quantity', '1') ~ '^[0-9]+(\.[0-9]+)?$' THEN COALESCE(it->>'quantity', '1')::numeric ELSE 1 END
                    * CASE WHEN COALESCE(it->>'unitPrice', '') ~ '^[0-9]+(\.[0-9]+)?$' THEN (it->>'unitPrice')::numeric ELSE 0 END
                ), 2), 0)
                FROM jsonb_array_elements(CASE WHEN jsonb_typeof(o."items") = 'array' THEN o."items" ELSE '[]'::jsonb END) it
            ), o."totalAmount")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "marketplace_orders" DROP COLUMN "productsAmount"`);
    }
}
