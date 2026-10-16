import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';
import { CategoryModule } from '../categories/category.module';
import { SyncModule } from '../sync/sync.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MarketplaceConnection } from '../sync/entities/marketplace-connection.entity';
import { MarketplaceCategory } from '../categories/entities/marketplace-category.entity';
import { ProductVisionService } from './product-vision.service';
import { ChannelAttributesService } from './channel-attributes.service';
import { FalabellaAutoPrepService } from './falabella-auto-prep.service';
import { FalabellaPrepController } from './falabella-prep.controller';
import { StoresModule } from '../stores/stores.module';
import { Product } from '../products/entities/product.entity';

@Module({
  imports: [CategoryModule, SyncModule, StoresModule, TypeOrmModule.forFeature([MarketplaceConnection, MarketplaceCategory, Product])],
  controllers: [AiController, FalabellaPrepController],
  providers: [AiService, ProductVisionService, ChannelAttributesService, FalabellaAutoPrepService],
  exports: [AiService],
})
export class AiModule { }
