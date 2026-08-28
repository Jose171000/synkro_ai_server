import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CrmController } from './crm.controller';
import { CrmService } from './crm.service';
import { Lead } from './entities/lead.entity';
import { YavendioImportService } from './yavendio-import.service';
import { SyncModule } from '../sync/sync.module';

@Module({
    imports: [TypeOrmModule.forFeature([Lead]), SyncModule],
    controllers: [CrmController],
    providers: [CrmService, YavendioImportService],
    exports: [CrmService],
})
export class CrmModule { }
