import { Module } from '@nestjs/common';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';
import { ProductModule } from '../products/products.module';
import { AuthModule } from '../auth/auth.module';
import { StoresModule } from '../stores/stores.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ListingLink } from '../sync/entities/listing-link.entity';

@Module({
    imports: [ProductModule, AuthModule, StoresModule, TypeOrmModule.forFeature([ListingLink])],
    controllers: [ExportController],
    providers: [ExportService],
})
export class ExportModule {}
