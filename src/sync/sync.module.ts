import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SectionAccessGuard } from '../common/guards/section-access.guard';
import { User } from '../users/entities/user.entity';
import { BullModule } from '@nestjs/bullmq';
import { SyncController } from './sync.controller';
import { ListingActionsService } from './listing-actions.service';
import { ProductOverviewService } from './product-overview.service';
import { FalabellaVariantImportService } from './falabella-variant-import.service';
import { FalabellaPublicPageService } from './falabella-public-page.service';
import { ProductGroup } from '../products/entities/product-group.entity';
import { StoreMember } from '../stores/entities/store-member.entity';
import { SaleAlertsService } from './sale-alerts.service';
import { ProductSheetService } from './product-sheet.service';
import { SyncService } from './sync.service';
import { SyncProcessor } from './sync.processor';
import { MeliApiService } from './meli/meli-api.service';
import { YavendioApiService } from './yavendio/yavendio-api.service';
import { YavendioSyncService } from './yavendio/yavendio-sync.service';
import { YavendioCatalogImportService } from './yavendio/yavendio-catalog-import.service';
import { YavendioOrdersService } from './yavendio/yavendio-orders.service';
import { FalabellaApiService } from './falabella/falabella-api.service';
import { WooApiService } from './woo/woo-api.service';
import { ShopifyApiService } from './shopify/shopify-api.service';
import { EcommerceSyncService } from './channels/ecommerce-sync.service';
import { CredentialsEncryptionService } from './credentials-encryption.service';
import { MarketplaceConnection } from './entities/marketplace-connection.entity';
import { ListingLink } from './entities/listing-link.entity';
import { MarketplaceOrder } from './entities/marketplace-order.entity';
import { MarketplaceFeed } from './falabella/entities/marketplace-feed.entity';
import { SyncChangeRequest } from './entities/sync-change-request.entity';
import { ChangeRequestsService } from './change-requests.service';
import { OrdersQueryService } from './orders-query.service';
import { StoresModule } from '../stores/stores.module';
import { Store } from '../stores/entities/store.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Product } from '../products/entities/product.entity';

@Module({
    imports: [
        TypeOrmModule.forFeature([MarketplaceConnection, ListingLink, MarketplaceOrder, MarketplaceFeed, SyncChangeRequest, Product, ProductGroup, User, Store, StoreMember]),
        BullModule.registerQueue({ name: 'marketplace-sync-queue' }),
        NotificationsModule,
        StoresModule,
    ],
    controllers: [SyncController],
    providers: [SyncService, ChangeRequestsService, OrdersQueryService, SyncProcessor, MeliApiService, YavendioApiService, YavendioSyncService, YavendioCatalogImportService, YavendioOrdersService, FalabellaApiService, WooApiService, ShopifyApiService, EcommerceSyncService, SaleAlertsService, ProductSheetService, ListingActionsService, ProductOverviewService, FalabellaVariantImportService, FalabellaPublicPageService, CredentialsEncryptionService, SectionAccessGuard],
    exports: [SyncService, YavendioApiService, FalabellaApiService, MeliApiService, ProductSheetService, ProductOverviewService],
})
export class SyncModule { }
