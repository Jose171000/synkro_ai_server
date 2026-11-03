import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Plano de cada pantalla para los mapas de clics de Superadmin › Actividad: la forma de sus bloques (títulos, tablas,
 * tarjetas, botones, campos...) con posición y tamaño. No guarda ningún texto ni dato de personas. Una fila por pantalla.
 */
export class PlanosDePantallas1791300000000 implements MigrationInterface {
    name = 'PlanosDePantallas1791300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "activity_layouts" (
            "screen" character varying(60) NOT NULL,
            "blocks" jsonb NOT NULL,
            "width" integer NOT NULL,
            "height" integer NOT NULL,
            "capturedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            CONSTRAINT "PK_activity_layouts" PRIMARY KEY ("screen")
        )`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "activity_layouts"`);
    }
}
