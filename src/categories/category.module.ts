import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MarketplaceCategory } from './entities/marketplace-category.entity';
import { VectorSearchService } from './vector-search.service';
import { CategorySeederService } from './category-seeder.service';
import { CategoryController } from './category.controller';
import { FalabellaCategoryImportService } from './falabella-category-import.service';
import { RipleyCategoryImportService } from './ripley-category-import.service';
import { MarketplaceValueList } from './entities/marketplace-value-list.entity';
import { SyncModule } from '../sync/sync.module';
import { MarketplaceConnection } from '../sync/entities/marketplace-connection.entity';

@Module({
    imports: [TypeOrmModule.forFeature([MarketplaceCategory, MarketplaceValueList, MarketplaceConnection]), SyncModule],
    controllers: [CategoryController],
    providers: [VectorSearchService, CategorySeederService, FalabellaCategoryImportService, RipleyCategoryImportService],
    exports: [VectorSearchService, CategorySeederService, FalabellaCategoryImportService, RipleyCategoryImportService],
})
export class CategoryModule { }
