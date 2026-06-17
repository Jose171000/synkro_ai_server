import { Module } from '@nestjs/common';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';
import { ProductModule } from '../products/products.module';
import { AuthModule } from '../auth/auth.module';

@Module({
    imports: [ProductModule, AuthModule],
    controllers: [ExportController],
    providers: [ExportService],
})
export class ExportModule {}
