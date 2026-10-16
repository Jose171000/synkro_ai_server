import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MarketplaceCategory } from './entities/marketplace-category.entity';
import { VectorSearchService } from './vector-search.service';
import { CategorySeederService } from './category-seeder.service';
import { CategoryController } from './category.controller';
import { FalabellaCategoryImportService } from './falabella-category-import.service';
import { SyncModule } from '../sync/sync.module';
import { MarketplaceConnection } from '../sync/entities/marketplace-connection.entity';

@Module({
    imports: [TypeOrmModule.forFeature([MarketplaceCategory, MarketplaceConnection]), SyncModule],
    controllers: [CategoryController],
    providers: [VectorSearchService, CategorySeederService, FalabellaCategoryImportService],
    exports: [VectorSearchService, CategorySeederService, FalabellaCategoryImportService],
})
export class CategoryModule { }
