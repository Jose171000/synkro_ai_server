import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';
import axios from 'axios';
import { imageSize } from 'image-size';

export interface UploadResult {
    url: string;
    secureUrl: string;
    publicId: string;
    width: number;
    height: number;
    format: string;
    bytes: number;
}

const ALLOWED_MIMES = ['image/jpeg', 'image/jpg'];
const MAX_DIMENSION = 2000;
const MAX_MB = 10;

@Injectable()
export class UploadService {
    private readonly logger = new Logger(UploadService.name);

    constructor(private readonly config: ConfigService) {
        cloudinary.config({
            cloud_name: config.get<string>('CLOUDINARY_CLOUD_NAME'),
            api_key:    config.get<string>('CLOUDINARY_API_KEY'),
            api_secret: config.get<string>('CLOUDINARY_API_SECRET'),
        });
    }

    // ─────────────────────────────────────────────────────────────
    // Public: Upload from Multer file
    // ─────────────────────────────────────────────────────────────
    async uploadImage(file: Express.Multer.File, folder = 'products'): Promise<UploadResult> {
        if (!file) throw new BadRequestException('No se proporcionó ningún archivo.');
        this.validateBuffer(file.buffer, file.mimetype, file.originalname);
        return this.streamUpload(file.buffer, folder);
    }

    async uploadImages(files: Express.Multer.File[], folder = 'products'): Promise<UploadResult[]> {
        if (!files?.length) throw new BadRequestException('No se proporcionaron archivos.');
        return Promise.all(files.map(f => this.uploadImage(f, folder)));
    }

    // ─────────────────────────────────────────────────────────────
    // Public: Upload raw buffer (e.g. extracted from ZIP)
    // ─────────────────────────────────────────────────────────────
    async uploadBuffer(buffer: Buffer, originalName: string, folder = 'products'): Promise<UploadResult> {
        // Infer mime from extension
        const ext = originalName.split('.').pop()?.toLowerCase() ?? '';
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
        this.validateBuffer(buffer, mime, originalName);
        return this.streamUpload(buffer, folder);
    }

    // ─────────────────────────────────────────────────────────────
    // Public: Validate and resolve an external URL
    // Returns the URL as-is if valid (no re-upload).
    // Throws BadRequestException if invalid.
    // ─────────────────────────────────────────────────────────────
    async validateExternalUrl(url: string): Promise<string> {
        let buffer: Buffer;
        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 10_000,
                maxContentLength: MAX_MB * 1024 * 1024,
            });

            const contentType: string = response.headers['content-type'] ?? '';
            if (!ALLOWED_MIMES.some(m => contentType.includes(m.replace('image/', '')))) {
                throw new BadRequestException(
                    `La URL no apunta a una imagen JPG/JPEG. Content-Type recibido: "${contentType}"`
                );
            }

            buffer = Buffer.from(response.data);
        } catch (err) {
            if (err instanceof BadRequestException) throw err;
            throw new BadRequestException(`No se pudo acceder a la imagen en la URL proporcionada: ${err.message}`);
        }

        this.validateDimensions(buffer, url);
        return url; // URL is valid — return it as-is
    }

    // ─────────────────────────────────────────────────────────────
    // Public: Delete from Cloudinary
    // ─────────────────────────────────────────────────────────────
    async deleteImage(publicId: string): Promise<void> {
        await cloudinary.uploader.destroy(publicId);
    }

    // ─────────────────────────────────────────────────────────────
    // Private: Validation helpers
    // ─────────────────────────────────────────────────────────────
    private validateBuffer(buffer: Buffer, mimetype: string, name: string): void {
        if (!ALLOWED_MIMES.includes(mimetype.toLowerCase())) {
            throw new BadRequestException(
                `Formato no permitido para "${name}": ${mimetype}. Solo se aceptan imágenes JPG/JPEG.`
            );
        }
        if (buffer.length > MAX_MB * 1024 * 1024) {
            throw new BadRequestException(`"${name}" supera el límite de ${MAX_MB} MB.`);
        }
        this.validateDimensions(buffer, name);
    }

    private validateDimensions(buffer: Buffer, name: string): void {
        try {
            const info = imageSize(buffer);
            if (!info.width || !info.height) return;
            if (info.width > MAX_DIMENSION || info.height > MAX_DIMENSION) {
                throw new BadRequestException(
                    `"${name}" excede las dimensiones máximas permitidas (${MAX_DIMENSION}x${MAX_DIMENSION}px). ` +
                    `Dimensiones detectadas: ${info.width}x${info.height}px.`
                );
            }
        } catch (err) {
            if (err instanceof BadRequestException) throw err;
            this.logger.warn(`No se pudieron verificar las dimensiones de "${name}": ${err.message}`);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Private: Stream buffer to Cloudinary (always saves as JPG)
    // ─────────────────────────────────────────────────────────────
    private streamUpload(buffer: Buffer, folder: string): Promise<UploadResult> {
        return new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                {
                    folder,
                    resource_type: 'image',
                    use_filename: false,
                    unique_filename: true,
                    format: 'jpg',           // Force JPEG storage
                    allowed_formats: ['jpg', 'jpeg'], // Block any other format at Cloudinary side
                    quality: 'auto:best',
                },
                (error, result) => {
                    if (error) return reject(error);
                    if (!result) return reject(new Error('Cloudinary no devolvió un resultado.'));

                    // Hard assert: if somehow Cloudinary stored another format, fail loudly
                    if (result.format !== 'jpg') {
                        return reject(new Error(
                            `Cloudinary almacenó el archivo como "${result.format}" en lugar de "jpg". ` +
                            `Verifica que la opción "Auto-Format" no esté habilitada globalmente en tu cuenta.`
                        ));
                    }

                    resolve({
                        url:       result.url,
                        secureUrl: result.secure_url,
                        publicId:  result.public_id,
                        width:     result.width,
                        height:    result.height,
                        format:    result.format,
                        bytes:     result.bytes,
                    });
                },
            );
            Readable.from(buffer).pipe(stream);
        });
    }
}
