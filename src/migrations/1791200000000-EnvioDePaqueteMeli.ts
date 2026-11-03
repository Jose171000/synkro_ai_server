import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Los productos de un paquete de Mercado Libre viajan en un solo envío, pero cada venta del paquete guardó el costo completo
 * de ese envío: se contaba una vez por producto. Se reparte en partes iguales entre las ventas con el mismo número de
 * seguimiento (lo nuevo ya se guarda repartido). No se puede deshacer sin conocer el costo original, por eso el down no hace nada.
 */
export class EnvioDePaqueteMeli1791200000000 implements MigrationInterface {
    name = 'EnvioDePaqueteMeli1791200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            UPDATE "marketplace_orders" o SET "shippingSellerCost" = ROUND(x.parte, 2)
            FROM (
                SELECT id,
                       "shippingSellerCost" / COUNT(*) OVER w AS parte,
                       COUNT(*) OVER w AS n
                FROM "marketplace_orders"
                WHERE marketplace = 'mercadolibre'
                  AND "shippingSellerCost" IS NOT NULL
                  AND details->'shipping'->>'trackingCode' IS NOT NULL
                WINDOW w AS (PARTITION BY "connectionId", details->'shipping'->>'trackingCode')
            ) x
            WHERE o.id = x.id AND x.n > 1
        `);
    }

    public async down(): Promise<void> {
        // El costo completo del envío se repetía en cada venta del paquete; no hay nada que restaurar.
    }
}
