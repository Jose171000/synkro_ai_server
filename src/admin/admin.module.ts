import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { MonthlyBilling } from './entities/monthly-billing.entity';
import { ClientProfile } from './entities/client-profile.entity';
import { Payment } from './entities/payment.entity';
import { User } from '../users/entities/user.entity';
import { Product } from '../products/entities/product.entity';
import { ListingLink } from '../sync/entities/listing-link.entity';
import { MarketplaceConnection } from '../sync/entities/marketplace-connection.entity';
import { MarketplaceOrder } from '../sync/entities/marketplace-order.entity';
import { ReportsModule } from '../reports/reports.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            ClientProfile,
            Payment,
            User,
            Product,
            ListingLink,
            MarketplaceConnection,
            MarketplaceOrder,
            MonthlyBilling,
        ]),
        ReportsModule,
    ],
    controllers: [AdminController, BillingController],
    providers: [AdminService, BillingService],
    exports: [AdminService, TypeOrmModule],
})
export class AdminModule { }
