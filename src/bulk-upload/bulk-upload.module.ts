import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BulkUploadController } from './bulk-upload.controller';
import { AiProcessor } from './ai.processor';
import { AiModule } from '../ai/ai.module';
import { ProductModule } from '../products/products.module';

@Module({
    imports: [
        BullModule.registerQueue({
            name: 'generate-listings-queue',
        }),
        AiModule,
        ProductModule,
    ],
    controllers: [BulkUploadController],
    providers: [AiProcessor],
})
export class BulkUploadModule { }
