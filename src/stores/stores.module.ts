import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { ListingLink } from '../sync/entities/listing-link.entity';
import { Store } from './entities/store.entity';
import { StoreInvitation } from './entities/store-invitation.entity';
import { StoreMember } from './entities/store-member.entity';
import { StoreAccessGuard } from './store-access.guard';
import { PublicStoresController, StoresController } from './stores.controller';
import { StoresService } from './stores.service';

@Module({
    imports: [TypeOrmModule.forFeature([Store, StoreMember, StoreInvitation, User, ListingLink])],
    controllers: [StoresController, PublicStoresController],
    providers: [StoresService, StoreAccessGuard],
    exports: [StoresService, StoreAccessGuard],
})
export class StoresModule { }
