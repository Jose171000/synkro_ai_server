import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SectionAccessGuard } from '../common/guards/section-access.guard';
import { User } from '../users/entities/user.entity';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { AiModule } from '../ai/ai.module';
import { Product } from './entities/product.entity';
import { ProductImage } from './entities/product-image.entity';
import { AuthModule } from '../auth/auth.module';
import { UploadModule } from '../upload/upload.module';
import { SyncModule } from '../sync/sync.module';
import { StoresModule } from '../stores/stores.module';
import { SkuUnicoService } from './sku-unico.service';
import { ProductGroupsService } from './product-groups.service';
import { SkuGeneratorService } from './sku-generator.service';
import { ProductGroup } from './entities/product-group.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Product, ProductImage, ProductGroup, User]),
    AiModule,
    AuthModule,
    UploadModule,
    SyncModule,
    StoresModule,
  ],
  controllers: [ProductsController],
  providers: [ProductsService, ProductGroupsService, SkuGeneratorService, SectionAccessGuard, SkuUnicoService],
  exports: [ProductsService, ProductGroupsService, SkuGeneratorService],
})
export class ProductModule { }