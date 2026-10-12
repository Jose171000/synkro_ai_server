import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { MarketplaceConnection } from '../sync/entities/marketplace-connection.entity';
import { ListingLink } from '../sync/entities/listing-link.entity';
import { MarketplaceOrder } from '../sync/entities/marketplace-order.entity';
import { Product } from '../products/entities/product.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { User } from '../users/entities/user.entity';
import { ClientProfile } from '../admin/entities/client-profile.entity';
import { Payment } from '../admin/entities/payment.entity';
import { MonthlyBilling } from '../admin/entities/monthly-billing.entity';
import { SyncChangeRequest } from '../sync/entities/sync-change-request.entity';
import { Store } from '../stores/entities/store.entity';
import { DashboardInsightsService } from './dashboard-insights.service';
import { StoresModule } from '../stores/stores.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            MarketplaceConnection, ListingLink, MarketplaceOrder,
            Product, Notification, User, ClientProfile, Payment, MonthlyBilling, SyncChangeRequest, Store,
        ]),
        StoresModule,
    ],
    controllers: [DashboardController],
    providers: [DashboardService, DashboardInsightsService],
})
export class DashboardModule { }
