import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import * as Joi from 'joi';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/user.module';
import { ProductModule } from './products/products.module';
import { AiModule } from './ai/ai.module';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { BulkUploadModule } from './bulk-upload/bulk-upload.module';
import { CategoryModule } from './categories/category.module';
import { RedisModule } from './redis/redis.module';
import { MailModule } from './mail/mail.module';
import { UploadModule } from './upload/upload.module';
import { ExportModule } from './export/export.module';
import { SyncModule } from './sync/sync.module';
import { AdminModule } from './admin/admin.module';
import { ReportsModule } from './reports/reports.module';
import { CrmModule } from './crm/crm.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        DB_HOST: Joi.string().required(),
        DB_PORT: Joi.number().default(5432),
        DB_USERNAME: Joi.string().required(),
        DB_PASSWORD: Joi.string().required(),
        DB_NAME: Joi.string().required(),
        JWT_SECRET: Joi.string().required(),
        NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
        MAIL_HOST: Joi.string().default('smtp.gmail.com'),
        MAIL_PORT: Joi.number().default(587),
        MAIL_USER: Joi.string().required(),
        MAIL_PASS: Joi.string().required(),
        MAIL_FROM: Joi.string().required(),
        FRONTEND_URL: Joi.string().default('http://localhost:3000'),
        CLOUDINARY_CLOUD_NAME: Joi.string().required(),
        CLOUDINARY_API_KEY: Joi.string().required(),
        CLOUDINARY_API_SECRET: Joi.string().required(),
        OPENAI_API_KEY: Joi.string().required(),
        DEEPSEEK_API_KEY: Joi.string().required(),
        REDIS_HOST: Joi.string().default('127.0.0.1'),
        REDIS_PORT: Joi.number().default(6379),
        REDIS_PASSWORD: Joi.string().optional().allow(''),
        MELI_CLIENT_ID: Joi.string().optional().allow(''),
        MELI_CLIENT_SECRET: Joi.string().optional().allow(''),
        MELI_REDIRECT_URI: Joi.string().optional().allow(''),
        MELI_SITE_ID: Joi.string().default('MPE'),
        MELI_CURRENCY_ID: Joi.string().default('PEN'),
        MELI_LISTING_TYPE_ID: Joi.string().default('gold_special'),
        ADMIN_EMAILS: Joi.string().optional().allow(''),
        // Si está definida, los correos salen por la API HTTP de Brevo
        // (necesario donde el hosting bloquea SMTP). Si no, se usa SMTP.
        BREVO_API_KEY: Joi.string().optional().allow(''),
      }),
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT || '5432'),
        username: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        // OJO: antes decía 'productions' (con s), así que synchronize
        // quedaba activo también en producción y TypeORM podía alterar
        // el esquema en cada despliegue. Ahora es explícito: se mantiene
        // activo por defecto hasta que existan migraciones, pero puede
        // apagarse con DB_SYNCHRONIZE=false sin tocar código.
        synchronize: process.env.DB_SYNCHRONIZE !== 'false',
      }),
      inject: [ConfigService],
    }),
    // Límite de peticiones por IP: frena fuerza bruta contra el login
    // y el abuso de los endpoints públicos (webhooks, recuperación).
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 1000, limit: 10 },
      { name: 'medium', ttl: 60_000, limit: 120 },
    ]),
    AuthModule,
    UsersModule,
    ProductModule,
    AiModule,
    CategoryModule,
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD || "",
      },
    }),
    BulkUploadModule,
    RedisModule,
    MailModule,
    UploadModule,
    ExportModule,
    SyncModule,
    AdminModule,
    ReportsModule,
    CrmModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule { }
