import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductModule } from '../products/products.module';
import { SyncModule } from '../sync/sync.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { ReportsModule } from '../reports/reports.module';
import { StoresModule } from '../stores/stores.module';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';
import { StoreApiKey } from './entities/store-api-key.entity';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';

/** MCP de solo lectura de una tienda: ver docs/mcp.md. No toca ningún servicio existente, solo los usa. */
@Module({
    imports: [TypeOrmModule.forFeature([StoreApiKey]), StoresModule, ProductModule, SyncModule, DashboardModule, ReportsModule],
    controllers: [McpController, ApiKeysController],
    providers: [ApiKeysService, McpService],
})
export class McpModule { }
