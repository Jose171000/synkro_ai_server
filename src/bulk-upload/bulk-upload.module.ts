import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BulkUploadController } from './bulk-upload.controller';
import { AiProcessor } from './ai.processor';
import { CategoryProcessor } from './category.processor';
import { ProductEditProcessor } from './product-edit.processor';
import { CategoryEditProcessor } from './category-edit.processor';
import { AiModule } from '../ai/ai.module';
import { ProductModule } from '../products/products.module';
import { CategoryModule } from '../categories/category.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from '../products/entities/product.entity';
import { MarketplaceCategory } from '../categories/entities/marketplace-category.entity';

@Module({
    imports: [
        BullModule.registerQueue(
            { name: 'generate-listings-queue' },
            { name: 'category-seed-queue' },
            { name: 'product-edit-queue' },
            { name: 'category-edit-queue' },
        ),
        TypeOrmModule.forFeature([Product, MarketplaceCategory]),
        AiModule,
        ProductModule,
        CategoryModule,
    ],
    controllers: [BulkUploadController],
    providers: [AiProcessor, CategoryProcessor, ProductEditProcessor, CategoryEditProcessor],
})
export class BulkUploadModule { }
