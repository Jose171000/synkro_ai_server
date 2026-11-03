import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StoreMember } from '../stores/entities/store-member.entity';
import { ActivityReportService } from './activity-report.service';
import { ActivityDaily, ActivityEvent, ActivityHourly, ActivitySession, PrivacyConsent } from './entities/activity.entity';
import { ActivityService } from './activity.service';
import { ActivityQueriesService } from './activity-queries.service';
import { PrivacyService } from './privacy.service';
import { ActivityController } from './activity.controller';
import { ActivityAdminController } from './activity-admin.controller';
import { ActivityInterceptor } from './activity.interceptor';

@Module({
    imports: [TypeOrmModule.forFeature([ActivityEvent, ActivitySession, ActivityDaily, ActivityHourly, PrivacyConsent, StoreMember])],
    controllers: [ActivityController, ActivityAdminController],
    providers: [ActivityService, ActivityQueriesService, ActivityReportService, PrivacyService, { provide: APP_INTERCEPTOR, useClass: ActivityInterceptor }],
    exports: [ActivityService, PrivacyService],
})
export class ActivityModule { }
