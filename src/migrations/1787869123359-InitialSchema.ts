import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1787869123359 implements MigrationInterface {
    name = 'InitialSchema1787869123359'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Extensiones que el esquema da por sentadas: uuid-ossp genera los ids
        // (uuid_generate_v4) y pgvector se usa en las búsquedas semánticas de
        // categorías. Sin esto, una base desde cero no se puede levantar.
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);
        await queryRunner.query(`CREATE TABLE "refresh_tokens" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "token" character varying NOT NULL, "expiresAt" TIMESTAMP NOT NULL, "isRevoked" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "userId" uuid, CONSTRAINT "PK_7d8bee0204106019488c4c50ffa" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "lastName" character varying NOT NULL, "email" character varying NOT NULL, "password" character varying NOT NULL, "nameCompany" character varying, "cellPhone" character varying, "country" character varying, "url" character varying, "role" character varying(20) NOT NULL DEFAULT 'user', "isActive" boolean NOT NULL DEFAULT true, "allowedSections" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "marketplace_connections" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "marketplace" character varying NOT NULL, "externalUserId" character varying NOT NULL, "externalNickname" character varying, "accessToken" text NOT NULL, "refreshToken" text, "secrets" text, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "status" character varying NOT NULL DEFAULT 'active', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "ownerId" uuid, CONSTRAINT "UQ_connection_marketplace_owner" UNIQUE ("marketplace", "ownerId"), CONSTRAINT "PK_9a70cbab701e4687297c51365ba" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "product_images" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "url" character varying NOT NULL, "productId" uuid, CONSTRAINT "PK_1974264ea7265989af8392f63a1" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "products" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "sku" character varying NOT NULL, "description" text NOT NULL, "aiTitle" character varying, "aiDescription" text, "aiKeywords" text, "aiAttributes" jsonb, "category" character varying, "subCategory" character varying, "price" numeric(10,2), "stock" integer NOT NULL DEFAULT '0', "marketplaceIds" jsonb, "targetMarketplaces" text, "status" character varying NOT NULL DEFAULT 'draft', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "ownerId" uuid, CONSTRAINT "UQ_product_sku_owner" UNIQUE ("sku", "ownerId"), CONSTRAINT "PK_0806c755e0aca124e67c0cf6d7d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "marketplace_orders" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "marketplace" character varying NOT NULL, "externalId" character varying NOT NULL, "totalAmount" numeric(12,2) NOT NULL, "currency" character varying(5) NOT NULL DEFAULT 'PEN', "itemsCount" integer NOT NULL DEFAULT '1', "items" jsonb, "status" character varying(30) NOT NULL DEFAULT 'paid', "orderDate" TIMESTAMP WITH TIME ZONE NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "ownerId" uuid NOT NULL, CONSTRAINT "UQ_order_marketplace_external" UNIQUE ("marketplace", "externalId"), CONSTRAINT "PK_357fa54c892b12b528e30d2b550" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_38a6a7179ad52bb5c4620706a5" ON "marketplace_orders" ("ownerId") `);
        await queryRunner.query(`CREATE TABLE "listing_links" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "marketplace" character varying NOT NULL, "externalId" character varying NOT NULL, "permalink" character varying, "syncStatus" character varying NOT NULL DEFAULT 'pending', "lastStockSynced" integer, "lastPriceSynced" numeric(10,2), "lastSyncedAt" TIMESTAMP WITH TIME ZONE, "lastError" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "productId" uuid, CONSTRAINT "UQ_listing_product_marketplace" UNIQUE ("productId", "marketplace"), CONSTRAINT "PK_485e9024dd16eaf20a8e48e67d0" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "leads" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "company" character varying, "email" character varying, "phone" character varying, "source" character varying, "stage" character varying(20) NOT NULL DEFAULT 'nuevo', "estimatedValue" numeric(12,2), "notes" text, "lastContactAt" date, "externalKey" character varying, "origin" character varying(20) NOT NULL DEFAULT 'manual', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_cd102ed7a9a4ca7d4d8bfeba406" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_14ee3f571bb43425136b0e4052" ON "leads" ("name") `);
        await queryRunner.query(`CREATE INDEX "IDX_b3eea7add0e16594dba102716c" ON "leads" ("email") `);
        await queryRunner.query(`CREATE INDEX "IDX_f56935cf2c01a66b47bf494741" ON "leads" ("externalKey") `);
        await queryRunner.query(`CREATE TABLE "marketplace_categories" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "marketplace" character varying NOT NULL, "categoryId" character varying NOT NULL, "name" character varying NOT NULL, "labelText" text NOT NULL, "requiredAttributes" jsonb, "embedding" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_category_marketplace" UNIQUE ("categoryId", "marketplace"), CONSTRAINT "PK_ccbec861df6ee237ddbe895c6d2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "password_resets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "token" character varying NOT NULL, "expiresAt" TIMESTAMP NOT NULL, "isUsed" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "userId" uuid, CONSTRAINT "PK_4816377aa98211c1de34469e742" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "payments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "amount" numeric(12,2) NOT NULL, "currency" character varying(5) NOT NULL DEFAULT 'PEN', "type" character varying(20) NOT NULL, "frequency" character varying(20), "concept" character varying NOT NULL, "method" character varying(30), "paidAt" date NOT NULL, "receiptRef" character varying, "notes" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "clientId" uuid NOT NULL, CONSTRAINT "PK_197ab7af18c93fbb0c9b28b4a59" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_e7c2e95ccd4bd2068c70744dd6" ON "payments" ("clientId") `);
        await queryRunner.query(`CREATE TABLE "monthly_billings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "period" character varying(7) NOT NULL, "totalSales" numeric(14,2) NOT NULL DEFAULT '0', "commissionRate" numeric(6,3) NOT NULL DEFAULT '0', "commissionAmount" numeric(14,2) NOT NULL DEFAULT '0', "currency" character varying(5) NOT NULL DEFAULT 'PEN', "status" character varying(20) NOT NULL DEFAULT 'pendiente', "invoiceRef" character varying, "invoicedAt" date, "salesSource" character varying(20) NOT NULL DEFAULT 'manual', "notes" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "clientId" uuid NOT NULL, CONSTRAINT "UQ_billing_client_period" UNIQUE ("clientId", "period"), CONSTRAINT "PK_ab8edee978049eea62541c97334" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_24be3b170d1483a389416297d0" ON "monthly_billings" ("clientId") `);
        await queryRunner.query(`CREATE INDEX "IDX_8f4e7b406ba733b614fd3dfd78" ON "monthly_billings" ("period") `);
        await queryRunner.query(`CREATE TABLE "client_profiles" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "ruc" character varying, "businessName" character varying, "fiscalAddress" character varying, "clientType" character varying(20) NOT NULL DEFAULT 'saas', "status" character varying(20) NOT NULL DEFAULT 'activo', "contactName" character varying, "contactPhone" character varying, "sheetCsvUrl" text, "reportEmbedUrl" text, "reportEmbedTitle" character varying, "notes" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "userId" uuid, CONSTRAINT "REL_af81cdb71317b2f0f6cb6bce77" UNIQUE ("userId"), CONSTRAINT "PK_fc4acd4b04f4a0537e7213f8ddd" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "refresh_tokens" ADD CONSTRAINT "FK_610102b60fea1455310ccd299de" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "marketplace_connections" ADD CONSTRAINT "FK_307f7e11920aaf0803c540c085f" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "product_images" ADD CONSTRAINT "FK_b367708bf720c8dd62fc6833161" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "products" ADD CONSTRAINT "FK_663aa9983fd61dfc310d407d4da" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" ADD CONSTRAINT "FK_38a6a7179ad52bb5c4620706a5c" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "listing_links" ADD CONSTRAINT "FK_cf489e48570f7afff9ebcff87a0" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "password_resets" ADD CONSTRAINT "FK_d95569f623f28a0bf034a55099e" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payments" ADD CONSTRAINT "FK_e7c2e95ccd4bd2068c70744dd65" FOREIGN KEY ("clientId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "monthly_billings" ADD CONSTRAINT "FK_24be3b170d1483a389416297d0c" FOREIGN KEY ("clientId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "client_profiles" ADD CONSTRAINT "FK_af81cdb71317b2f0f6cb6bce776" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "client_profiles" DROP CONSTRAINT "FK_af81cdb71317b2f0f6cb6bce776"`);
        await queryRunner.query(`ALTER TABLE "monthly_billings" DROP CONSTRAINT "FK_24be3b170d1483a389416297d0c"`);
        await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT "FK_e7c2e95ccd4bd2068c70744dd65"`);
        await queryRunner.query(`ALTER TABLE "password_resets" DROP CONSTRAINT "FK_d95569f623f28a0bf034a55099e"`);
        await queryRunner.query(`ALTER TABLE "listing_links" DROP CONSTRAINT "FK_cf489e48570f7afff9ebcff87a0"`);
        await queryRunner.query(`ALTER TABLE "marketplace_orders" DROP CONSTRAINT "FK_38a6a7179ad52bb5c4620706a5c"`);
        await queryRunner.query(`ALTER TABLE "products" DROP CONSTRAINT "FK_663aa9983fd61dfc310d407d4da"`);
        await queryRunner.query(`ALTER TABLE "product_images" DROP CONSTRAINT "FK_b367708bf720c8dd62fc6833161"`);
        await queryRunner.query(`ALTER TABLE "marketplace_connections" DROP CONSTRAINT "FK_307f7e11920aaf0803c540c085f"`);
        await queryRunner.query(`ALTER TABLE "refresh_tokens" DROP CONSTRAINT "FK_610102b60fea1455310ccd299de"`);
        await queryRunner.query(`DROP TABLE "client_profiles"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8f4e7b406ba733b614fd3dfd78"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_24be3b170d1483a389416297d0"`);
        await queryRunner.query(`DROP TABLE "monthly_billings"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e7c2e95ccd4bd2068c70744dd6"`);
        await queryRunner.query(`DROP TABLE "payments"`);
        await queryRunner.query(`DROP TABLE "password_resets"`);
        await queryRunner.query(`DROP TABLE "marketplace_categories"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f56935cf2c01a66b47bf494741"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b3eea7add0e16594dba102716c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_14ee3f571bb43425136b0e4052"`);
        await queryRunner.query(`DROP TABLE "leads"`);
        await queryRunner.query(`DROP TABLE "listing_links"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_38a6a7179ad52bb5c4620706a5"`);
        await queryRunner.query(`DROP TABLE "marketplace_orders"`);
        await queryRunner.query(`DROP TABLE "products"`);
        await queryRunner.query(`DROP TABLE "product_images"`);
        await queryRunner.query(`DROP TABLE "marketplace_connections"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP TABLE "refresh_tokens"`);
    }

}
