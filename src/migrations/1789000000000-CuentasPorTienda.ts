import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Las cuentas de canales pasan a pertenecer a una tienda, y una tienda admite
 * varias cuentas del mismo marketplace.
 *
 * Lo que cambia, y por qué:
 *  - marketplace_connections: ahora cuelga de una tienda y puede haber varias
 *    por canal. La clave única deja de ser (canal, dueño) y pasa a ser
 *    (tienda, canal, cuenta del vendedor): la misma cuenta no se conecta dos
 *    veces a una tienda, pero sí puede haber otra cuenta del mismo canal.
 *  - listing_links: cada publicación recuerda en qué cuenta está. Una misma
 *    ficha puede estar en dos cuentas, así que la clave única pasa a ser
 *    (producto, cuenta).
 *  - products, marketplace_feeds, sync_change_requests: saben a qué tienda y
 *    cuenta pertenecen.
 *  - users: marca las cuentas creadas por invitación, que no pueden crear tiendas.
 *  - stores: el modo revisión pasa a ser de la tienda y no de la persona.
 *
 * Todo lo existente se asigna a la tienda de su dueño (la que creó la
 * migración anterior), así que nada se queda sin tienda y nada cambia de
 * lugar para quien ya usaba la app. Las columnas nuevas son opcionales.
 */
export class CuentasPorTienda1789000000000 implements MigrationInterface {
    name = 'CuentasPorTienda1789000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // ── Usuarios y tiendas ─────────────────────────────────────
        await queryRunner.query(`ALTER TABLE "users" ADD "createdFromInvitation" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "stores" ADD "syncReviewMode" boolean NOT NULL DEFAULT true`);
        await queryRunner.query(`
            UPDATE "stores" s SET "syncReviewMode" = u."syncReviewMode"
            FROM "users" u WHERE u."id" = s."ownerId"
        `);

        // ── Cuentas de canales ─────────────────────────────────────
        await queryRunner.query(`ALTER TABLE "marketplace_connections" ADD "storeId" uuid`);
        await queryRunner.query(`ALTER TABLE "marketplace_connections" ADD "label" character varying`);
        await queryRunner.query(`
            UPDATE "marketplace_connections" c SET "storeId" = (
                SELECT s."id" FROM "stores" s WHERE s."ownerId" = c."ownerId" ORDER BY s."createdAt" ASC LIMIT 1
            )
        `);
        await queryRunner.query(`ALTER TABLE "marketplace_connections" ADD CONSTRAINT "FK_connection_store" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "marketplace_connections" DROP CONSTRAINT IF EXISTS "UQ_connection_marketplace_owner"`);
        await queryRunner.query(`ALTER TABLE "marketplace_connections" ADD CONSTRAINT "UQ_connection_store_marketplace_account" UNIQUE ("storeId", "marketplace", "externalUserId")`);

        // ── Productos ──────────────────────────────────────────────
        await queryRunner.query(`ALTER TABLE "products" ADD "storeId" uuid`);
        await queryRunner.query(`
            UPDATE "products" p SET "storeId" = (
                SELECT s."id" FROM "stores" s WHERE s."ownerId" = p."ownerId" ORDER BY s."createdAt" ASC LIMIT 1
            )
        `);
        await queryRunner.query(`ALTER TABLE "products" ADD CONSTRAINT "FK_product_store" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`CREATE INDEX "IDX_product_store" ON "products" ("storeId")`);

        // ── Publicaciones ──────────────────────────────────────────
        await queryRunner.query(`ALTER TABLE "listing_links" ADD "connectionId" uuid`);
        await queryRunner.query(`
            UPDATE "listing_links" l SET "connectionId" = c."id"
            FROM "products" p, "marketplace_connections" c
            WHERE l."productId" = p."id" AND c."marketplace" = l."marketplace" AND c."ownerId" = p."ownerId"
        `);
        await queryRunner.query(`ALTER TABLE "listing_links" ADD CONSTRAINT "FK_link_connection" FOREIGN KEY ("connectionId") REFERENCES "marketplace_connections"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "listing_links" DROP CONSTRAINT IF EXISTS "UQ_listing_product_marketplace"`);
        await queryRunner.query(`ALTER TABLE "listing_links" ADD CONSTRAINT "UQ_listing_product_connection" UNIQUE ("productId", "connectionId")`);
        await queryRunner.query(`CREATE INDEX "IDX_link_connection" ON "listing_links" ("connectionId")`);

        // ── Lotes enviados a Falabella ─────────────────────────────
        await queryRunner.query(`ALTER TABLE "marketplace_feeds" ADD "connectionId" uuid`);
        await queryRunner.query(`
            UPDATE "marketplace_feeds" f SET "connectionId" = c."id"
            FROM "marketplace_connections" c
            WHERE c."marketplace" = f."marketplace" AND c."ownerId" = f."ownerId"
        `);
        await queryRunner.query(`ALTER TABLE "marketplace_feeds" ADD CONSTRAINT "FK_feed_connection" FOREIGN KEY ("connectionId") REFERENCES "marketplace_connections"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);

        // ── Cola de revisión ───────────────────────────────────────
        await queryRunner.query(`ALTER TABLE "sync_change_requests" ADD "storeId" uuid`);
        await queryRunner.query(`ALTER TABLE "sync_change_requests" ADD "connectionId" uuid`);
        await queryRunner.query(`
            UPDATE "sync_change_requests" r SET "storeId" = p."storeId"
            FROM "products" p WHERE p."id" = r."productId"
        `);
        await queryRunner.query(`
            UPDATE "sync_change_requests" r SET "connectionId" = l."connectionId"
            FROM "listing_links" l WHERE l."productId" = r."productId" AND l."marketplace" = r."marketplace"
        `);
        await queryRunner.query(`ALTER TABLE "sync_change_requests" ADD CONSTRAINT "FK_change_request_store" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "sync_change_requests" ADD CONSTRAINT "FK_change_request_connection" FOREIGN KEY ("connectionId") REFERENCES "marketplace_connections"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "sync_change_requests" DROP CONSTRAINT "FK_change_request_connection"`);
        await queryRunner.query(`ALTER TABLE "sync_change_requests" DROP CONSTRAINT "FK_change_request_store"`);
        await queryRunner.query(`ALTER TABLE "sync_change_requests" DROP COLUMN "connectionId"`);
        await queryRunner.query(`ALTER TABLE "sync_change_requests" DROP COLUMN "storeId"`);

        await queryRunner.query(`ALTER TABLE "marketplace_feeds" DROP CONSTRAINT "FK_feed_connection"`);
        await queryRunner.query(`ALTER TABLE "marketplace_feeds" DROP COLUMN "connectionId"`);

        await queryRunner.query(`DROP INDEX "public"."IDX_link_connection"`);
        await queryRunner.query(`ALTER TABLE "listing_links" DROP CONSTRAINT "UQ_listing_product_connection"`);
        await queryRunner.query(`ALTER TABLE "listing_links" ADD CONSTRAINT "UQ_listing_product_marketplace" UNIQUE ("productId", "marketplace")`);
        await queryRunner.query(`ALTER TABLE "listing_links" DROP CONSTRAINT "FK_link_connection"`);
        await queryRunner.query(`ALTER TABLE "listing_links" DROP COLUMN "connectionId"`);

        await queryRunner.query(`DROP INDEX "public"."IDX_product_store"`);
        await queryRunner.query(`ALTER TABLE "products" DROP CONSTRAINT "FK_product_store"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "storeId"`);

        await queryRunner.query(`ALTER TABLE "marketplace_connections" DROP CONSTRAINT "UQ_connection_store_marketplace_account"`);
        await queryRunner.query(`ALTER TABLE "marketplace_connections" ADD CONSTRAINT "UQ_connection_marketplace_owner" UNIQUE ("marketplace", "ownerId")`);
        await queryRunner.query(`ALTER TABLE "marketplace_connections" DROP CONSTRAINT "FK_connection_store"`);
        await queryRunner.query(`ALTER TABLE "marketplace_connections" DROP COLUMN "label"`);
        await queryRunner.query(`ALTER TABLE "marketplace_connections" DROP COLUMN "storeId"`);

        await queryRunner.query(`ALTER TABLE "stores" DROP COLUMN "syncReviewMode"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "createdFromInvitation"`);
    }

}
