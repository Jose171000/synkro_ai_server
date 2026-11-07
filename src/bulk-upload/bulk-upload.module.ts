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
import { SyncModule } from '../sync/sync.module';
import { StoresModule } from '../stores/stores.module';
import { BulkBatch } from './entities/bulk-batch.entity';
import { BulkBatchItem } from './entities/bulk-batch-item.entity';
import { BulkBatchService } from './bulk-batch.service';
import { EdicionMasivaService } from './edicion-masiva.service';

@Module({
    imports: [
        BullModule.registerQueue(
            { name: 'generate-listings-queue' },
            { name: 'category-seed-queue' },
            { name: 'product-edit-queue' },
            { name: 'category-edit-queue' },
        ),
        TypeOrmModule.forFeature([Product, MarketplaceCategory, User, BulkBatch, BulkBatchItem]),
        AiModule,
        ProductModule,
        CategoryModule,
        UploadModule,
        MailModule,
        RedisModule,
        SyncModule,
        StoresModule,
    ],
    controllers: [BulkUploadController],
    providers: [
        AiProcessor,
        CategoryProcessor,
        ProductEditProcessor,
        CategoryEditProcessor,
        BatchNotificationService, BulkBatchService, EdicionMasivaService, SectionAccessGuard],
})
export class BulkUploadModule { }
