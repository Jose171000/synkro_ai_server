import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { MarketplaceOrder } from '../sync/entities/marketplace-order.entity';
import { ClientProfile } from '../admin/entities/client-profile.entity';

@Module({
    imports: [TypeOrmModule.forFeature([MarketplaceOrder, ClientProfile])],
    controllers: [ReportsController],
    providers: [ReportsService],
    exports: [ReportsService],
})
export class ReportsModule { }
