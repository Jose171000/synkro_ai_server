import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { ClientProfile } from './entities/client-profile.entity';
import { Payment } from './entities/payment.entity';
import { User } from '../users/entities/user.entity';
import { Product } from '../products/entities/product.entity';
import { ListingLink } from '../sync/entities/listing-link.entity';
import { MarketplaceConnection } from '../sync/entities/marketplace-connection.entity';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            ClientProfile,
            Payment,
            User,
            Product,
            ListingLink,
            MarketplaceConnection,
        ]),
    ],
    controllers: [AdminController],
    providers: [AdminService],
    exports: [AdminService, TypeOrmModule],
})
export class AdminModule { }
