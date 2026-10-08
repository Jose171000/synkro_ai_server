import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Tiendas, miembros e invitaciones.
 *
 * Es ADITIVA: solo crea tablas nuevas. Los datos que ya existen (productos,
 * conexiones, pedidos...) siguen colgando de su usuario y no se mueven aquí;
 * eso se hace en una fase posterior, tabla por tabla.
 *
 * Lo único que toca datos: a cada usuario existente le crea una tienda propia
 * y lo deja como su dueño, para que nadie quede sin tienda cuando la app
 * empiece a pedirla. El nombre sale de su empresa o, si no tiene, de su
 * nombre. El enlace público nace apagado y sin código: nadie lo activó.
 */
export class TiendasYMiembros1788900000000 implements MigrationInterface {
    name = 'TiendasYMiembros1788900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "stores" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "publicToken" character varying, "publicEnabled" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "ownerId" uuid NOT NULL, CONSTRAINT "UQ_stores_publicToken" UNIQUE ("publicToken"), CONSTRAINT "PK_stores" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_stores_owner" ON "stores" ("ownerId") `);
        await queryRunner.query(`ALTER TABLE "stores" ADD CONSTRAINT "FK_stores_owner" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

        await queryRunner.query(`CREATE TABLE "store_members" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "role" character varying(10) NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "storeId" uuid NOT NULL, "userId" uuid NOT NULL, CONSTRAINT "UQ_store_member" UNIQUE ("storeId", "userId"), CONSTRAINT "PK_store_members" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "store_members" ADD CONSTRAINT "FK_store_members_store" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "store_members" ADD CONSTRAINT "FK_store_members_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

        await queryRunner.query(`CREATE TABLE "store_invitations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying NOT NULL, "role" character varying(10) NOT NULL, "tokenHash" character varying NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "acceptedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "storeId" uuid NOT NULL, "invitedById" uuid NOT NULL, CONSTRAINT "PK_store_invitations" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_store_invitations_email" ON "store_invitations" ("email") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_store_invitations_token" ON "store_invitations" ("tokenHash") `);
        await queryRunner.query(`ALTER TABLE "store_invitations" ADD CONSTRAINT "FK_store_invitations_store" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "store_invitations" ADD CONSTRAINT "FK_store_invitations_user" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

        // Una tienda propia por cada usuario existente, con él como dueño.
        await queryRunner.query(`
            INSERT INTO "stores" ("name", "ownerId")
            SELECT COALESCE(NULLIF(TRIM(u."nameCompany"), ''), TRIM(u."name" || ' ' || u."lastName")), u."id"
            FROM "users" u
        `);
        await queryRunner.query(`
            INSERT INTO "store_members" ("storeId", "userId", "role")
            SELECT s."id", s."ownerId", 'owner' FROM "stores" s
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "store_invitations" DROP CONSTRAINT "FK_store_invitations_user"`);
        await queryRunner.query(`ALTER TABLE "store_invitations" DROP CONSTRAINT "FK_store_invitations_store"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_store_invitations_token"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_store_invitations_email"`);
        await queryRunner.query(`DROP TABLE "store_invitations"`);
        await queryRunner.query(`ALTER TABLE "store_members" DROP CONSTRAINT "FK_store_members_user"`);
        await queryRunner.query(`ALTER TABLE "store_members" DROP CONSTRAINT "FK_store_members_store"`);
        await queryRunner.query(`DROP TABLE "store_members"`);
        await queryRunner.query(`ALTER TABLE "stores" DROP CONSTRAINT "FK_stores_owner"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_stores_owner"`);
        await queryRunner.query(`DROP TABLE "stores"`);
    }

}
