import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Cliente al que pertenece cada tienda. La agencia crea y configura las tiendas
 * de sus clientes desde sus propias cuentas, así que el dueño de la tienda no
 * dice de quién es el negocio. Opcional: las que no se asignan se reconocen por
 * su dueño o por su nombre, o quedan sin asignar para hacerlo desde el panel.
 */
export class ClienteDeLaTienda1789800000000 implements MigrationInterface {
    name = 'ClienteDeLaTienda1789800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "stores" ADD "clientId" uuid`);
        await queryRunner.query(`CREATE INDEX "IDX_stores_clientId" ON "stores" ("clientId")`);
        await queryRunner.query(`ALTER TABLE "stores" ADD CONSTRAINT "FK_stores_clientId" FOREIGN KEY ("clientId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "stores" DROP CONSTRAINT "FK_stores_clientId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_stores_clientId"`);
        await queryRunner.query(`ALTER TABLE "stores" DROP COLUMN "clientId"`);
    }
}
