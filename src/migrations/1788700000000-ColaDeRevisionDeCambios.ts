import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Modo revisión: los cambios de precio y stock pueden esperar aprobación
 * antes de enviarse a los canales.
 *
 * Añade la tabla donde esperan esos cambios y un interruptor por usuario.
 * El interruptor nace ENCENDIDO: quien ya usaba la app pasa a revisar sus
 * cambios hasta que lo apague en Ajustes. Es lo pedido (arranca en revisión)
 * y evita que un precio mal tecleado llegue solo a Falabella.
 */
export class ColaDeRevisionDeCambios1788700000000 implements MigrationInterface {
    name = 'ColaDeRevisionDeCambios1788700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD "syncReviewMode" boolean NOT NULL DEFAULT true`);
        await queryRunner.query(`CREATE TABLE "sync_change_requests" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "marketplace" character varying NOT NULL, "field" character varying(10) NOT NULL, "previousValue" character varying, "newValue" character varying NOT NULL, "status" character varying(10) NOT NULL DEFAULT 'pending', "resultMessage" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "resolvedAt" TIMESTAMP WITH TIME ZONE, "productId" uuid, "requestedById" uuid, CONSTRAINT "PK_sync_change_requests" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_change_request_owner_status" ON "sync_change_requests" ("requestedById", "status") `);
        await queryRunner.query(`ALTER TABLE "sync_change_requests" ADD CONSTRAINT "FK_change_request_product" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "sync_change_requests" ADD CONSTRAINT "FK_change_request_user" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "sync_change_requests" DROP CONSTRAINT "FK_change_request_user"`);
        await queryRunner.query(`ALTER TABLE "sync_change_requests" DROP CONSTRAINT "FK_change_request_product"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_change_request_owner_status"`);
        await queryRunner.query(`DROP TABLE "sync_change_requests"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "syncReviewMode"`);
    }

}
