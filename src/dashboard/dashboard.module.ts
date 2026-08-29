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

@Module({
    imports: [
        TypeOrmModule.forFeature([
            MarketplaceConnection, ListingLink, MarketplaceOrder,
            Product, Notification, User, ClientProfile,
        ]),
    ],
    controllers: [DashboardController],
    providers: [DashboardService],
})
export class DashboardModule { }
