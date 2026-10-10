import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Mercado Libre añade a veces un código propio al final del SKU
 * («140-001-271_AZUL__32141126»). Los productos ya importados con ese sufijo
 * recuperan su SKU real. Si el SKU limpio ya existe para el mismo dueño, el
 * producto no se toca (evita duplicar): queda para revisarlo a mano.
 */
export class LimpiarSkuDeMercadoLibre1789400000000 implements MigrationInterface {
    name = 'LimpiarSkuDeMercadoLibre1789400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            UPDATE "products" p
            SET "sku" = regexp_replace(p."sku", '__[0-9]+$', '')
            WHERE p."sku" ~ '__[0-9]+$'
              AND regexp_replace(p."sku", '__[0-9]+$', '') <> ''
              AND EXISTS (SELECT 1 FROM "listing_links" l WHERE l."productId" = p."id" AND l."marketplace" = 'mercadolibre')
              AND NOT EXISTS (
                  SELECT 1 FROM "products" q
                  WHERE q."ownerId" = p."ownerId" AND q."id" <> p."id"
                    AND q."sku" = regexp_replace(p."sku", '__[0-9]+$', '')
              )
        `);
    }

    public async down(): Promise<void> {
        // No reversible: el sufijo original no se conserva.
    }
}
