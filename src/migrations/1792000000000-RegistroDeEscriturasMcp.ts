import { MigrationInterface, QueryRunner } from "typeorm";

/** Registro de las escrituras hechas por el MCP (docs/mcp.md). Se borra con su tienda; las claves y usuarios van sueltos. */
export class RegistroDeEscriturasMcp1792000000000 implements MigrationInterface {
    name = 'RegistroDeEscriturasMcp1792000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "mcp_write_log" (
            "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
            "storeId" uuid NOT NULL,
            "keyId" uuid NOT NULL,
            "keyName" character varying(60) NOT NULL,
            "userId" uuid NOT NULL,
            "tool" character varying(60) NOT NULL,
            "resumen" jsonb NOT NULL DEFAULT '{}',
            "estado" character varying(10) NOT NULL DEFAULT 'pendiente',
            "mensaje" character varying(500),
            "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            CONSTRAINT "PK_mcp_write_log" PRIMARY KEY ("id"),
            CONSTRAINT "FK_mcp_write_log_store" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE
        )`);
        await queryRunner.query(`CREATE INDEX "IDX_mcp_write_log_store" ON "mcp_write_log" ("storeId")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_mcp_write_log_store"`);
        await queryRunner.query(`DROP TABLE "mcp_write_log"`);
    }
}
