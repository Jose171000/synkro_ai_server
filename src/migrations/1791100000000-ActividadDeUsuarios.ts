import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Registro de actividad de los usuarios y consentimiento del aviso de privacidad. Solo lo consulta el superadmin.
 * No guarda contenido: etiquetas de pantallas y elementos, y cuándo. Detalle 90 días, resúmenes 2 años.
 */
export class ActividadDeUsuarios1791100000000 implements MigrationInterface {
    name = 'ActividadDeUsuarios1791100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "privacy_consents" (
            "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
            "userId" uuid NOT NULL,
            "version" character varying(20) NOT NULL,
            "via" character varying(12) NOT NULL,
            "acceptedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            CONSTRAINT "PK_privacy_consents" PRIMARY KEY ("id"),
            CONSTRAINT "UQ_privacy_consent" UNIQUE ("userId", "version"),
            CONSTRAINT "FK_privacy_consents_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
        )`);

        await queryRunner.query(`CREATE TABLE "activity_sessions" (
            "id" uuid NOT NULL,
            "userId" uuid NOT NULL,
            "storeId" uuid,
            "platformRole" character varying(20) NOT NULL,
            "storeRole" character varying(10) NOT NULL DEFAULT '',
            "device" character varying(12) NOT NULL DEFAULT 'escritorio',
            "startedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
            "lastSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL,
            "activeSeconds" integer NOT NULL DEFAULT 0,
            CONSTRAINT "PK_activity_sessions" PRIMARY KEY ("id"),
            CONSTRAINT "FK_activity_sessions_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
        )`);
        await queryRunner.query(`CREATE INDEX "IDX_activity_sessions_user" ON "activity_sessions" ("userId", "startedAt")`);
        await queryRunner.query(`CREATE INDEX "IDX_activity_sessions_started" ON "activity_sessions" ("startedAt")`);

        await queryRunner.query(`CREATE TABLE "activity_events" (
            "id" BIGSERIAL NOT NULL,
            "userId" uuid NOT NULL,
            "storeId" uuid,
            "sessionId" uuid,
            "at" TIMESTAMP WITH TIME ZONE NOT NULL,
            "type" character varying(10) NOT NULL,
            "screen" character varying(60) NOT NULL,
            "element" character varying(80),
            "action" character varying(120),
            "x" smallint, "y" smallint, "ex" smallint, "ey" smallint, "ew" smallint, "eh" smallint,
            "value" smallint,
            "platformRole" character varying(20) NOT NULL,
            "storeRole" character varying(10) NOT NULL DEFAULT '',
            CONSTRAINT "PK_activity_events" PRIMARY KEY ("id"),
            CONSTRAINT "FK_activity_events_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
        )`);
        await queryRunner.query(`CREATE INDEX "IDX_activity_events_user_at" ON "activity_events" ("userId", "at")`);
        await queryRunner.query(`CREATE INDEX "IDX_activity_events_at" ON "activity_events" ("at")`);
        await queryRunner.query(`CREATE INDEX "IDX_activity_events_screen" ON "activity_events" ("screen", "type")`);

        await queryRunner.query(`CREATE TABLE "activity_daily" (
            "id" BIGSERIAL NOT NULL,
            "day" date NOT NULL,
            "userId" uuid NOT NULL,
            "platformRole" character varying(20) NOT NULL,
            "storeRole" character varying(10) NOT NULL DEFAULT '',
            "type" character varying(10) NOT NULL,
            "screen" character varying(60) NOT NULL,
            "element" character varying(120) NOT NULL DEFAULT '',
            "n" integer NOT NULL,
            "ex" smallint, "ey" smallint, "ew" smallint, "eh" smallint,
            CONSTRAINT "PK_activity_daily" PRIMARY KEY ("id"),
            CONSTRAINT "UQ_activity_daily" UNIQUE ("day", "userId", "type", "screen", "element", "platformRole", "storeRole"),
            CONSTRAINT "FK_activity_daily_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
        )`);
        await queryRunner.query(`CREATE INDEX "IDX_activity_daily_day" ON "activity_daily" ("day")`);
        await queryRunner.query(`CREATE INDEX "IDX_activity_daily_screen" ON "activity_daily" ("screen", "type", "day")`);

        await queryRunner.query(`CREATE TABLE "activity_hourly" (
            "id" BIGSERIAL NOT NULL,
            "day" date NOT NULL,
            "userId" uuid NOT NULL,
            "platformRole" character varying(20) NOT NULL,
            "storeRole" character varying(10) NOT NULL DEFAULT '',
            "hour" smallint NOT NULL,
            "events" integer NOT NULL,
            "seconds" integer NOT NULL,
            CONSTRAINT "PK_activity_hourly" PRIMARY KEY ("id"),
            CONSTRAINT "UQ_activity_hourly" UNIQUE ("day", "userId", "platformRole", "storeRole", "hour"),
            CONSTRAINT "FK_activity_hourly_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
        )`);
        await queryRunner.query(`CREATE INDEX "IDX_activity_hourly_day" ON "activity_hourly" ("day")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "activity_hourly"`);
        await queryRunner.query(`DROP TABLE "activity_daily"`);
        await queryRunner.query(`DROP TABLE "activity_events"`);
        await queryRunner.query(`DROP TABLE "activity_sessions"`);
        await queryRunner.query(`DROP TABLE "privacy_consents"`);
    }
}
