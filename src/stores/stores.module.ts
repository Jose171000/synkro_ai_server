import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { ListingLink } from '../sync/entities/listing-link.entity';
import { Store } from './entities/store.entity';
import { StoreInvitation } from './entities/store-invitation.entity';
import { StoreMember } from './entities/store-member.entity';
import { StoreCustomRole } from './entities/store-custom-role.entity';
import { StoreRolesService } from './store-roles.service';
import { StoreAccessGuard } from './store-access.guard';
import { PublicStoresController, StoresController } from './stores.controller';
import { StoresService } from './stores.service';

@Module({
    imports: [TypeOrmModule.forFeature([Store, StoreMember, StoreInvitation, StoreCustomRole, User, ListingLink])],
    controllers: [StoresController, PublicStoresController],
    providers: [StoresService, StoreRolesService, StoreAccessGuard],
    exports: [StoresService, StoreRolesService, StoreAccessGuard],
})
export class StoresModule { }
