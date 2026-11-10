import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Las listas cerradas de valores de un canal (colores, tipos de producto de Ripley…) se guardan una sola vez, en una tabla propia,
 * y los atributos de cada categoría las referencian por su código.
 */
export class ListasDeValoresDeCanal1791600000000 implements MigrationInterface {
    name = 'ListasDeValoresDeCanal1791600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "marketplace_value_lists" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "marketplace" character varying NOT NULL,
                "code" character varying NOT NULL,
                "label" text,
                "values" jsonb NOT NULL DEFAULT '[]',
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "UQ_value_list_marketplace_code" UNIQUE ("marketplace", "code"),
                CONSTRAINT "PK_marketplace_value_lists" PRIMARY KEY ("id")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "marketplace_value_lists"`);
    }
}
