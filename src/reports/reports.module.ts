import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { MarketplaceOrder } from '../sync/entities/marketplace-order.entity';
import { ClientProfile } from '../admin/entities/client-profile.entity';
import { Store } from '../stores/entities/store.entity';
import { Product } from '../products/entities/product.entity';
import { ListingLink } from '../sync/entities/listing-link.entity';
import { StoresModule } from '../stores/stores.module';

@Module({
    imports: [TypeOrmModule.forFeature([MarketplaceOrder, ClientProfile, Store, Product, ListingLink]), StoresModule],
    controllers: [ReportsController],
    providers: [ReportsService],
    exports: [ReportsService],
})
export class ReportsModule { }
