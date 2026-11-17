import { MigrationInterface, QueryRunner } from "typeorm";

/** Consumo real de IA: una fila por llamada (tokens y costo en USD), para saber cuánto cuesta cada usuario. */
export class UsoDeIa1791700000000 implements MigrationInterface {
    name = 'UsoDeIa1791700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "ai_usage_log" (
            "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
            "userId" uuid,
            "operation" character varying NOT NULL,
            "runId" uuid,
            "provider" character varying NOT NULL,
            "model" character varying NOT NULL,
            "promptTokens" integer NOT NULL DEFAULT 0,
            "cachedTokens" integer NOT NULL DEFAULT 0,
            "completionTokens" integer NOT NULL DEFAULT 0,
            "costUsd" numeric(14,8) NOT NULL DEFAULT 0,
            "priceKnown" boolean NOT NULL DEFAULT true,
            "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
            CONSTRAINT "PK_ai_usage_log" PRIMARY KEY ("id")
        )`);
        await queryRunner.query(`CREATE INDEX "IDX_ai_usage_user_fecha" ON "ai_usage_log" ("userId", "createdAt")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "ai_usage_log"`);
    }
}
