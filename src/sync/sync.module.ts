import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { SyncProcessor } from './sync.processor';
import { MeliApiService } from './meli/meli-api.service';
import { MarketplaceConnection } from './entities/marketplace-connection.entity';
import { ListingLink } from './entities/listing-link.entity';
import { MarketplaceOrder } from './entities/marketplace-order.entity';
import { Product } from '../products/entities/product.entity';

@Module({
    imports: [
        TypeOrmModule.forFeature([MarketplaceConnection, ListingLink, MarketplaceOrder, Product]),
        BullModule.registerQueue({ name: 'marketplace-sync-queue' }),
    ],
    controllers: [SyncController],
    providers: [SyncService, SyncProcessor, MeliApiService],
    exports: [SyncService],
})
export class SyncModule { }
