import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MarketplaceCategory } from './entities/marketplace-category.entity';
import { VectorSearchService } from './vector-search.service';
import { CategorySeederService } from './category-seeder.service';
import { CategoryController } from './category.controller';

@Module({
    imports: [TypeOrmModule.forFeature([MarketplaceCategory])],
    controllers: [CategoryController],
    providers: [VectorSearchService, CategorySeederService],
    exports: [VectorSearchService, CategorySeederService],
})
export class CategoryModule { }
