import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CrmController } from './crm.controller';
import { CrmService } from './crm.service';
import { Lead } from './entities/lead.entity';
import { YavendioImportService } from './yavendio-import.service';
import { SyncModule } from '../sync/sync.module';
import { User } from '../users/entities/user.entity';
import { SectionAccessGuard } from '../common/guards/section-access.guard';

@Module({
    imports: [TypeOrmModule.forFeature([Lead, User]), SyncModule],
    controllers: [CrmController],
    providers: [CrmService, YavendioImportService, SectionAccessGuard],
    exports: [CrmService],
})
export class CrmModule { }
