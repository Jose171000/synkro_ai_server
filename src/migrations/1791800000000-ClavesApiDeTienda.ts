import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Claves de acceso al MCP de cada tienda (docs/mcp.md). Solo se guarda el hash de la clave y un prefijo para reconocerla.
 * Al borrarse la tienda o quien la creó, la clave desaparece con ellos.
 */
export class ClavesApiDeTienda1791800000000 implements MigrationInterface {
    name = 'ClavesApiDeTienda1791800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "store_api_keys" (
            "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
            "storeId" uuid NOT NULL,
            "createdById" uuid NOT NULL,
            "name" character varying(60) NOT NULL,
            "keyHash" character varying(64) NOT NULL,
            "prefix" character varying(16) NOT NULL,
            "permissions" jsonb NOT NULL DEFAULT '[]',
            "expiresAt" TIMESTAMP WITH TIME ZONE,
            "revokedAt" TIMESTAMP WITH TIME ZONE,
            "lastUsedAt" TIMESTAMP WITH TIME ZONE,
            "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            CONSTRAINT "PK_store_api_keys" PRIMARY KEY ("id"),
            CONSTRAINT "FK_store_api_keys_store" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE,
            CONSTRAINT "FK_store_api_keys_user" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE
        )`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_store_api_keys_hash" ON "store_api_keys" ("keyHash")`);
        await queryRunner.query(`CREATE INDEX "IDX_store_api_keys_store" ON "store_api_keys" ("storeId")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_store_api_keys_store"`);
        await queryRunner.query(`DROP INDEX "UQ_store_api_keys_hash"`);
        await queryRunner.query(`DROP TABLE "store_api_keys"`);
    }
}
