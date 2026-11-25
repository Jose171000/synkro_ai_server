import { Module } from '@nestjs/common';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';
import { ProductModule } from '../products/products.module';
import { AuthModule } from '../auth/auth.module';
import { StoresModule } from '../stores/stores.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ListingLink } from '../sync/entities/listing-link.entity';
import { MarketplaceConnection } from '../sync/entities/marketplace-connection.entity';
import { SyncModule } from '../sync/sync.module';
import { FichasPorCanalService } from './fichas-por-canal.service';

@Module({
    imports: [ProductModule, AuthModule, StoresModule, SyncModule, TypeOrmModule.forFeature([ListingLink, MarketplaceConnection])],
    controllers: [ExportController],
    providers: [ExportService, FichasPorCanalService],
})
export class ExportModule {}
