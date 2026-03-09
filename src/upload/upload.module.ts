import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ConfigModule } from '@nestjs/config';
import { memoryStorage } from 'multer';
import { UploadService } from './upload.service';
import { UploadController } from './upload.controller';

@Module({
    imports: [
        ConfigModule,
        // Use memory storage — files go straight to Cloudinary, never touch disk
        MulterModule.register({ storage: memoryStorage() }),
    ],
    controllers: [UploadController],
    providers: [UploadService],
    exports: [UploadService],
})
export class UploadModule {}
