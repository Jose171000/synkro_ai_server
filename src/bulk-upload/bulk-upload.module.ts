import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BulkUploadController } from './bulk-upload.controller';
import { AiProcessor } from './ai.processor';
import { CategoryProcessor } from './category.processor';
import { ProductEditProcessor } from './product-edit.processor';
import { CategoryEditProcessor } from './category-edit.processor';
import { BatchNotificationService } from './batch-notification.service';
import { AiModule } from '../ai/ai.module';
import { ProductModule } from '../products/products.module';
import { CategoryModule } from '../categories/category.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SectionAccessGuard } from '../common/guards/section-access.guard';
import { User } from '../users/entities/user.entity';
import { Product } from '../products/entities/product.entity';
import { MarketplaceCategory } from '../categories/entities/marketplace-category.entity';
import { UploadModule } from '../upload/upload.module';
import { MailModule } from '../mail/mail.module';
import { RedisModule } from '../redis/redis.module';

@Module({
    imports: [
        BullModule.registerQueue(
            { name: 'generate-listings-queue' },
            { name: 'category-seed-queue' },
            { name: 'product-edit-queue' },
            { name: 'category-edit-queue' },
        ),
        TypeOrmModule.forFeature([Product, MarketplaceCategory, User]),
        AiModule,
        ProductModule,
        CategoryModule,
        UploadModule,
        MailModule,
        RedisModule,
    ],
    controllers: [BulkUploadController],
    providers: [
        AiProcessor,
        CategoryProcessor,
        ProductEditProcessor,
        CategoryEditProcessor,
        BatchNotificationService, SectionAccessGuard],
})
export class BulkUploadModule { }
