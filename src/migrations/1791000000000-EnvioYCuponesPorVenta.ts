import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Envío y cupones de cada venta (ver costos-de-venta.ts), y corrección de la hora de los pedidos de Falabella.
 *
 * Falabella manda la fecha del pedido sin zona horaria («2026-11-02 19:01:49», hora de Perú) y se guardaba leyéndola como
 * hora universal: todos sus pedidos quedaron 5 horas antes (Perú no tiene horario de verano). Se corrigen sumando 5 horas.
 * Lo nuevo se guarda ya bien (el código lee la fecha con la zona de Perú).
 *
 * Las ventas que ya existen se completan con lo guardado: el envío pagado por el comprador (Falabella: de sus artículos;
 * Mercado Libre: lo pagado menos los productos) y el cupón de Falabella (precio del artículo menos lo pagado). El costo
 * del envío gratis de Mercado Libre y los cupones de Mercado Libre se completan al volver a leer esas ventas del canal.
 */
export class EnvioYCuponesPorVenta1791000000000 implements MigrationInterface {
    name = 'EnvioYCuponesPorVenta1791000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "marketplace_orders" ADD "shippingPaid" numeric(12,2) NOT NULL DEFAULT 0`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" ADD "shippingSellerCost" numeric(12,2)`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" ADD "shippingType" character varying(20) NOT NULL DEFAULT 'sin_dato'`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" ADD "discountAmount" numeric(12,2) NOT NULL DEFAULT 0`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" ADD "discountSellerFunded" numeric(12,2)`);

        // Falabella: el envío que pagó el comprador sale de sus artículos; el cupón, de precio del artículo menos lo pagado.
        await queryRunner.query(`
            UPDATE "marketplace_orders" o SET
                "shippingPaid" = x.envio,
                "shippingType" = CASE WHEN x.envio > 0 THEN 'comprador' ELSE 'sin_dato' END,
                "discountAmount" = x.cupon
            FROM (
                SELECT id,
                    COALESCE((SELECT SUM(COALESCE((i->>'shippingAmount')::numeric, 0)) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(items) = 'array' THEN items ELSE '[]'::jsonb END) i), 0) AS envio,
                    COALESCE((SELECT SUM(GREATEST(COALESCE((i->>'listPrice')::numeric, 0) - COALESCE((i->>'unitPrice')::numeric, 0), 0)) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(items) = 'array' THEN items ELSE '[]'::jsonb END) i), 0) AS cupon
                FROM "marketplace_orders" WHERE marketplace = 'falabella'
            ) x
            WHERE o.id = x.id`);

        // Mercado Libre: lo que el comprador pagó de más sobre los productos es el envío.
        await queryRunner.query(`
            UPDATE "marketplace_orders" SET
                "shippingPaid" = GREATEST(NULLIF(details->'payment'->>'paidAmount', '')::numeric - "totalAmount", 0),
                "shippingType" = CASE WHEN NULLIF(details->'payment'->>'paidAmount', '')::numeric - "totalAmount" > 0 THEN 'comprador' ELSE 'sin_dato' END
            WHERE marketplace = 'mercadolibre' AND NULLIF(details->'payment'->>'paidAmount', '') IS NOT NULL`);

        // Las ventas registradas a mano ya guardan el envío cobrado.
        await queryRunner.query(`
            UPDATE "marketplace_orders" SET
                "shippingPaid" = COALESCE(NULLIF(details->>'shippingAmount', '')::numeric, 0),
                "shippingType" = CASE WHEN COALESCE(NULLIF(details->>'shippingAmount', '')::numeric, 0) > 0 THEN 'comprador' ELSE 'sin_dato' END
            WHERE details->>'manual' = 'true'`);

        // La hora de los pedidos de Falabella estaba 5 horas antes.
        await queryRunner.query(`UPDATE "marketplace_orders" SET "orderDate" = "orderDate" + interval '5 hours' WHERE marketplace = 'falabella'`);

        await queryRunner.query(`CREATE INDEX "IDX_marketplace_orders_store_date" ON "marketplace_orders" ("storeId", "orderDate")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_marketplace_orders_store_date"`);
        await queryRunner.query(`UPDATE "marketplace_orders" SET "orderDate" = "orderDate" - interval '5 hours' WHERE marketplace = 'falabella'`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" DROP COLUMN "discountSellerFunded"`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" DROP COLUMN "discountAmount"`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" DROP COLUMN "shippingType"`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" DROP COLUMN "shippingSellerCost"`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" DROP COLUMN "shippingPaid"`);
    }
}
