import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import * as Joi from 'joi';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/user.module';
import { ProductModule } from './products/products.module';
import { AiModule } from './ai/ai.module';
import { BullModule } from '@nestjs/bullmq';
import { BulkUploadModule } from './bulk-upload/bulk-upload.module';
import { CategoryModule } from './categories/category.module';
import { RedisModule } from './redis/redis.module';
import { MailModule } from './mail/mail.module';
import { UploadModule } from './upload/upload.module';

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
        synchronize: configService.get('NODE_ENV') !== 'production',
      }),
      inject: [ConfigService],
    }),
    AuthModule,
    UsersModule,
    ProductModule,
    AiModule,
    CategoryModule,
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379'),
      },
    }),
    BulkUploadModule,
    RedisModule,
    MailModule,
    UploadModule,
  ],
})
export class AppModule { }
