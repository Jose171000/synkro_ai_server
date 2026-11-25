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
import { UploadModule } from '../upload/upload.module';
import { McpWriteLog } from './entities/mcp-write-log.entity';
import { McpEscriturasService } from './mcp-escrituras.service';

/**
 * MCP: el de cada tienda (`/mcp`, claves `syk_`: lectura y, si la clave lo lleva, crear y editar productos sin publicar) y el
 * de plataforma para superadmins (`/mcp/admin`, claves `sya_`, solo lectura). Ver docs/mcp.md.
 */
@Module({
    imports: [TypeOrmModule.forFeature([StoreApiKey, McpWriteLog, Store, User]), UploadModule, StoresModule, ProductModule, SyncModule, DashboardModule, ReportsModule, AdminModule],
    controllers: [McpController, McpPlataformaController, ApiKeysController, AdminApiKeysController],
    providers: [ApiKeysService, McpService, McpPlataformaService, McpEscriturasService],
})
export class McpModule { }
