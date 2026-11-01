import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Registro durable de las cargas masivas: un lote (`bulk_batches`) y un renglón por producto (`bulk_batch_items`) con su estado
 * y el motivo si falló. Redis sigue llevando la cuenta y el cierre del lote; esto es lo que queda cuando Redis caduca o se reinicia.
 */
export class LotesDeCargaMasiva1790700000000 implements MigrationInterface {
    name = 'LotesDeCargaMasiva1790700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "bulk_batches" (
            "id" uuid NOT NULL,
            "userId" uuid NOT NULL,
            "storeId" uuid,
            "total" integer NOT NULL DEFAULT 0,
            "status" character varying NOT NULL DEFAULT 'running',
            "rejected" jsonb NOT NULL DEFAULT '[]',
            "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
            "finishedAt" TIMESTAMP,
            CONSTRAINT "PK_bulk_batches" PRIMARY KEY ("id")
        )`);
        await queryRunner.query(`CREATE INDEX "IDX_bulk_batches_user" ON "bulk_batches" ("userId", "createdAt")`);
        await queryRunner.query(`CREATE TABLE "bulk_batch_items" (
            "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
            "batchId" uuid NOT NULL,
            "sku" character varying NOT NULL,
            "status" character varying NOT NULL DEFAULT 'pendiente',
            "error" text,
            "productId" uuid,
            "falabellaStatus" character varying,
            "payload" jsonb,
            "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
            "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
            CONSTRAINT "PK_bulk_batch_items" PRIMARY KEY ("id"),
            CONSTRAINT "FK_bulk_batch_items_batch" FOREIGN KEY ("batchId") REFERENCES "bulk_batches"("id") ON DELETE CASCADE
        )`);
        await queryRunner.query(`CREATE INDEX "IDX_bulk_batch_items_batch_sku" ON "bulk_batch_items" ("batchId", "sku")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "bulk_batch_items"`);
        await queryRunner.query(`DROP TABLE "bulk_batches"`);
    }
}
