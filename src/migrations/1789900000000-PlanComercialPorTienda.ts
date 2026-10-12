import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Cada tienda es un cliente de la agencia: el plan comercial (cuota, comisión,
 * IGV, fecha de cobro) y los pagos pasan a ser de la tienda, no del usuario.
 * Lo que ya estaba cargado en el perfil de un usuario se copia a sus tiendas
 * (las suyas, o la que lleva el nombre de su negocio). La asignación de tienda
 * a cliente (stores.clientId) deja de hacer falta y se quita.
 */
export class PlanComercialPorTienda1789900000000 implements MigrationInterface {
    name = 'PlanComercialPorTienda1789900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "stores" ADD "billingModel" character varying(20) NOT NULL DEFAULT 'ninguno'`);
        await queryRunner.query(`ALTER TABLE "stores" ADD "monthlyFee" numeric(12,2)`);
        await queryRunner.query(`ALTER TABLE "stores" ADD "feeFrequency" character varying(20) NOT NULL DEFAULT 'mensual'`);
        await queryRunner.query(`ALTER TABLE "stores" ADD "commissionRate" numeric(6,3)`);
        await queryRunner.query(`ALTER TABLE "stores" ADD "nextDueDate" date`);
        await queryRunner.query(`ALTER TABLE "stores" ADD "planCurrency" character varying(5) NOT NULL DEFAULT 'PEN'`);
        await queryRunner.query(`ALTER TABLE "stores" ADD "feeIncludesIgv" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "stores" ADD "commissionIncludesIgv" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "stores" ADD "planStartDate" date`);
        await queryRunner.query(`ALTER TABLE "stores" ADD "proposalNotes" text`);

        await queryRunner.query(`ALTER TABLE "payments" ADD "storeId" uuid`);
        await queryRunner.query(`CREATE INDEX "IDX_payments_storeId" ON "payments" ("storeId")`);
        await queryRunner.query(`ALTER TABLE "payments" ADD CONSTRAINT "FK_payments_storeId" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);

        // Lo ya cargado en el perfil de un usuario pasa a sus tiendas: las que son suyas (si no es un
        // superadmin) o la que lleva el nombre de su negocio (sin tildes ni mayúsculas).
        await queryRunner.query(`
            UPDATE "stores" s SET
                "billingModel" = p."billingModel", "monthlyFee" = p."monthlyFee", "feeFrequency" = p."feeFrequency",
                "commissionRate" = p."commissionRate", "nextDueDate" = p."nextDueDate", "planCurrency" = p."planCurrency",
                "feeIncludesIgv" = p."feeIncludesIgv", "commissionIncludesIgv" = p."commissionIncludesIgv",
                "planStartDate" = p."planStartDate", "proposalNotes" = p."proposalNotes"
            FROM "client_profiles" p
            JOIN "users" u ON u."id" = p."userId"
            WHERE p."billingModel" <> 'ninguno'
              AND s."billingModel" = 'ninguno'
              AND (
                    (s."ownerId" = u."id" AND u."role" <> 'admin')
                 OR translate(lower(trim(s."name")), 'áéíóúñ', 'aeioun') IN (
                        translate(lower(trim(COALESCE(p."businessName", ''))), 'áéíóúñ', 'aeioun'),
                        translate(lower(trim(COALESCE(u."nameCompany", ''))), 'áéíóúñ', 'aeioun'),
                        translate(lower(trim(u."name" || ' ' || u."lastName")), 'áéíóúñ', 'aeioun')
                    )
              )
        `);

        // La asignación manual de tienda a cliente ya no existe: el cliente es la tienda.
        await queryRunner.query(`ALTER TABLE "stores" DROP CONSTRAINT IF EXISTS "FK_stores_clientId"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_stores_clientId"`);
        await queryRunner.query(`ALTER TABLE "stores" DROP COLUMN IF EXISTS "clientId"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "stores" ADD "clientId" uuid`);
        await queryRunner.query(`CREATE INDEX "IDX_stores_clientId" ON "stores" ("clientId")`);
        await queryRunner.query(`ALTER TABLE "stores" ADD CONSTRAINT "FK_stores_clientId" FOREIGN KEY ("clientId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);

        await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT "FK_payments_storeId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_payments_storeId"`);
        await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "storeId"`);

        for (const columna of ['proposalNotes', 'planStartDate', 'commissionIncludesIgv', 'feeIncludesIgv', 'planCurrency', 'nextDueDate', 'commissionRate', 'feeFrequency', 'monthlyFee', 'billingModel']) {
            await queryRunner.query(`ALTER TABLE "stores" DROP COLUMN "${columna}"`);
        }
    }
}
