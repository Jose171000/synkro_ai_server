import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductModule } from '../products/products.module';
import { SyncModule } from '../sync/sync.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { ReportsModule } from '../reports/reports.module';
import { StoresModule } from '../stores/stores.module';
import { AdminModule } from '../admin/admin.module';
import { Store } from '../stores/entities/store.entity';
import { User } from '../users/entities/user.entity';
import { AdminApiKeysController } from './admin-api-keys.controller';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';
import { StoreApiKey } from './entities/store-api-key.entity';
import { McpController } from './mcp.controller';
import { McpPlataformaController } from './mcp-plataforma.controller';
import { McpPlataformaService } from './mcp-plataforma.service';
import { McpService } from './mcp.service';

/**
 * MCP de solo lectura: el de cada tienda (`/mcp`, claves `syk_`) y el de plataforma para superadmins (`/mcp/admin`, claves
 * `sya_`). Ver docs/mcp.md. No toca ningún servicio existente, solo los usa.
 */
@Module({
    imports: [TypeOrmModule.forFeature([StoreApiKey, Store, User]), StoresModule, ProductModule, SyncModule, DashboardModule, ReportsModule, AdminModule],
    controllers: [McpController, McpPlataformaController, ApiKeysController, AdminApiKeysController],
    providers: [ApiKeysService, McpService, McpPlataformaService],
})
export class McpModule { }
