import { Controller, Post, UseInterceptors, UploadedFile, BadRequestException, HttpCode, HttpStatus, UseGuards, Req } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as xlsx from 'xlsx';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@ApiTags('bulk-upload')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('bulk-upload')
export class BulkUploadController {
    constructor(
        @InjectQueue('generate-listings-queue') private readonly listingsQueue: Queue,
    ) { }

    @Post('excel')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Upload an Excel file to bulk process products via AI' })
    @ApiConsumes('multipart/form-data')
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                file: {
                    type: 'string',
                    format: 'binary',
                },
            },
        },
    })
    @UseInterceptors(FileInterceptor('file'))
    async uploadExcel(@UploadedFile() file: Express.Multer.File, @Req() req) {
        if (!file) {
            throw new BadRequestException('El archivo Excel es obligatorio.');
        }

        try {
            const workbook = xlsx.read(file.buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const rows = xlsx.utils.sheet_to_json(worksheet);

            if (rows.length === 0) {
                throw new BadRequestException('El Excel está vacío.');
            }

            // Show the user the actual raw headers from the first row to help them debug
            if (rows.length > 0) {
                console.log(`[BulkUpload] Columnas detectadas en tu Excel:`, Object.keys(rows[0] as object));
            }

            // Normalizador dinámico de llaves buscando ignorar mayúsculas y espacios
            const mappedRows = rows.map((row: any) => {
                const getVal = (possibleKeys: string[]) => {
                    const foundKey = Object.keys(row).find(k => possibleKeys.includes(k.toLowerCase().trim()));
                    return foundKey ? row[foundKey] : undefined;
                };

                return {
                    sku: getVal(['sku']),
                    productName: getVal(['productname', 'nombre', 'name', 'producto']),
                    description: getVal(['description', 'descripcion', 'descripción', 'detalle']),
                    targetMarketplaces: (getVal(['targetmarketplaces', 'marketplaces']) || 'amazon,mercadolibre').split(',').map(s => s.trim().toLowerCase()),
                    userId: req.user.id,
                };
            }).filter(r => {
                const isValid = r.sku && r.productName && r.description && r.userId;
                if (!isValid) console.log(`[BulkUpload] Fila descartada por faltar datos clave -> SKU: ${r.sku}, Nombre: ${r.productName}, Desc: ${!!r.description}`);
                return isValid;
            });

            console.log(`[BulkUpload] Parseadas ${rows.length} filas desde el Excel. Filas válidas resultantes: ${mappedRows.length}`);

            for (const item of mappedRows) {
                await this.listingsQueue.add('process-product', item);
            }

            return {
                message: 'Archivo recibido correctamente. Las tareas han sido encoladas para procesamiento en segundo plano.',
                totalQueued: mappedRows.length,
            };
        } catch (error) {
            console.error('Error parseando excel:', error);
            throw new BadRequestException('Hubo un error al leer el archivo Excel.');
        }
    }
}
