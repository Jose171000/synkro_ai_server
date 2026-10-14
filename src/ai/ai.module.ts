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

@Module({
  imports: [CategoryModule, SyncModule, TypeOrmModule.forFeature([MarketplaceConnection, MarketplaceCategory])],
  controllers: [AiController],
  providers: [AiService, ProductVisionService, ChannelAttributesService],
  exports: [AiService],
})
export class AiModule { }
