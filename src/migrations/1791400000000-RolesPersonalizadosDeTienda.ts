import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Roles personalizados de cada tienda (docs/roles-de-tienda.md). Un rol personalizado es un nombre y un conjunto de permisos.
 *
 * Un miembro (o una invitación) con rol personalizado guarda además `customRoleId`; su columna `role` queda en «viewer», el
 * rol de fábrica con menos poder, para que ninguna regla que mire solo el nombre del rol le dé más de lo que tiene. Los
 * permisos reales salen del rol personalizado. La clave foránea es RESTRICT: un rol en uso no se puede borrar.
 */
export class RolesPersonalizadosDeTienda1791400000000 implements MigrationInterface {
    name = 'RolesPersonalizadosDeTienda1791400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "store_custom_roles" (
            "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
            "storeId" uuid NOT NULL,
            "name" character varying(40) NOT NULL,
            "permissions" jsonb NOT NULL DEFAULT '[]',
            "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            CONSTRAINT "PK_store_custom_roles" PRIMARY KEY ("id"),
            CONSTRAINT "FK_store_custom_roles_store" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE
        )`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_store_custom_roles_name" ON "store_custom_roles" ("storeId", lower("name"))`);

        await queryRunner.query(`ALTER TABLE "store_members" ADD "customRoleId" uuid`);
        await queryRunner.query(`ALTER TABLE "store_members" ADD CONSTRAINT "FK_store_members_custom_role" FOREIGN KEY ("customRoleId") REFERENCES "store_custom_roles"("id") ON DELETE RESTRICT`);
        await queryRunner.query(`CREATE INDEX "IDX_store_members_custom_role" ON "store_members" ("customRoleId")`);

        await queryRunner.query(`ALTER TABLE "store_invitations" ADD "customRoleId" uuid`);
        await queryRunner.query(`ALTER TABLE "store_invitations" ADD CONSTRAINT "FK_store_invitations_custom_role" FOREIGN KEY ("customRoleId") REFERENCES "store_custom_roles"("id") ON DELETE RESTRICT`);
        await queryRunner.query(`CREATE INDEX "IDX_store_invitations_custom_role" ON "store_invitations" ("customRoleId")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Quien tenía un rol personalizado queda como lector (su rol de fábrica base): nunca con más poder del que tenía.
        await queryRunner.query(`DROP INDEX "IDX_store_invitations_custom_role"`);
        await queryRunner.query(`ALTER TABLE "store_invitations" DROP CONSTRAINT "FK_store_invitations_custom_role"`);
        await queryRunner.query(`ALTER TABLE "store_invitations" DROP COLUMN "customRoleId"`);
        await queryRunner.query(`DROP INDEX "IDX_store_members_custom_role"`);
        await queryRunner.query(`ALTER TABLE "store_members" DROP CONSTRAINT "FK_store_members_custom_role"`);
        await queryRunner.query(`ALTER TABLE "store_members" DROP COLUMN "customRoleId"`);
        await queryRunner.query(`DROP INDEX "UQ_store_custom_roles_name"`);
        await queryRunner.query(`DROP TABLE "store_custom_roles"`);
    }
}
