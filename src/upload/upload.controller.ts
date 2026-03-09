import {
    Controller, Post, UseInterceptors, UploadedFile,
    UploadedFiles, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UploadService } from './upload.service';

@ApiTags('upload')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('upload')
export class UploadController {
    constructor(private readonly uploadService: UploadService) {}

    /**
     * Upload a single product image to Cloudinary.
     * Returns the secure URL to associate with a product.
     */
    @Post('image')
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary: 'Subir una imagen a Cloudinary',
        description: 'Sube una imagen (JPEG, PNG, WebP, GIF — máx. 10 MB). La imagen se convierte automáticamente a JPG y se almacena en Cloudinary. Devuelve la URL segura para asociar al producto.',
    })
    @ApiConsumes('multipart/form-data')
    @ApiBody({
        schema: {
            type: 'object',
            properties: { file: { type: 'string', format: 'binary' } },
        },
    })
    @UseInterceptors(FileInterceptor('file'))
    async uploadImage(@UploadedFile() file: Express.Multer.File) {
        const result = await this.uploadService.uploadImage(file, 'products');
        return {
            message: 'Imagen subida exitosamente.',
            url: result.secureUrl,
            publicId: result.publicId,
            dimensions: { width: result.width, height: result.height },
            format: result.format,
            sizeBytes: result.bytes,
        };
    }

    /**
     * Upload up to 10 product images in one request.
     */
    @Post('images')
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary: 'Subir múltiples imágenes a Cloudinary (máx. 10)',
        description: 'Sube hasta 10 imágenes en un solo request. Todas se convierten a WebP automáticamente.',
    })
    @ApiConsumes('multipart/form-data')
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                files: {
                    type: 'array',
                    items: { type: 'string', format: 'binary' },
                },
            },
        },
    })
    @UseInterceptors(FilesInterceptor('files', 10))
    async uploadImages(@UploadedFiles() files: Express.Multer.File[]) {
        const results = await this.uploadService.uploadImages(files, 'products');
        return {
            message: `${results.length} imagen(es) subida(s) exitosamente.`,
            images: results.map(r => ({
                url: r.secureUrl,
                publicId: r.publicId,
                dimensions: { width: r.width, height: r.height },
                format: r.format,
                sizeBytes: r.bytes,
            })),
        };
    }
}
