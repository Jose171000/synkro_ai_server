import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SectionAccessGuard } from '../common/guards/section-access.guard';
import { User } from '../users/entities/user.entity';
import { BullModule } from '@nestjs/bullmq';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { SyncProcessor } from './sync.processor';
import { MeliApiService } from './meli/meli-api.service';
import { YavendioApiService } from './yavendio/yavendio-api.service';
import { FalabellaApiService } from './falabella/falabella-api.service';
import { CredentialsEncryptionService } from './credentials-encryption.service';
import { MarketplaceConnection } from './entities/marketplace-connection.entity';
import { ListingLink } from './entities/listing-link.entity';
import { MarketplaceOrder } from './entities/marketplace-order.entity';
import { MarketplaceFeed } from './falabella/entities/marketplace-feed.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Product } from '../products/entities/product.entity';

@Module({
    imports: [
        TypeOrmModule.forFeature([MarketplaceConnection, ListingLink, MarketplaceOrder, MarketplaceFeed, Product, User]),
        BullModule.registerQueue({ name: 'marketplace-sync-queue' }),
        NotificationsModule,
    ],
    controllers: [SyncController],
    providers: [SyncService, SyncProcessor, MeliApiService, YavendioApiService, FalabellaApiService, CredentialsEncryptionService, SectionAccessGuard],
    exports: [SyncService, YavendioApiService, FalabellaApiService],
})
export class SyncModule { }
