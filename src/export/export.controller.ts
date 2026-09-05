import {
    Controller,
    Get,
    Param,
    Query,
    Req,
    Res,
    UseGuards,
    BadRequestException,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ExportService, ExportFormat } from './export.service';
import { ExportQueryDto } from './dto/export-query.dto';

const VALID_FORMATS: ExportFormat[] = ['json', 'csv', 'xlsx'];

@ApiTags('export')
@ApiBearerAuth()
@Controller('export')
@UseGuards(JwtAuthGuard)
export class ExportController {
    constructor(private readonly exportService: ExportService) {}

    @Get('products/:format')
    @ApiOperation({
        summary: 'Exportar todos los productos del usuario',
        description:
            'Descarga el catálogo completo de productos en el formato indicado (json, csv, xlsx). ' +
            'Soporta filtros opcionales por search, marketplace, category, subCategory, precio y stock.',
    })
    @ApiParam({
        name: 'format',
        enum: ['json', 'csv', 'xlsx'],
        description: 'Formato de exportación',
    })
    async exportProducts(
        @Param('format') format: string,
        @Query() filters: ExportQueryDto,
        @Req() req,
        @Res() res: Response,
    ) {
        this.validateFormat(format);

        const products = await this.exportService.getProductsForExport(
            req.user.id,
            filters,
        );
        const mapped = this.exportService.mapProductsForExport(products);

        return this.sendFile(res, mapped, 'products', 'Products', format as ExportFormat);
    }

    @Get('ai-content/:format')
    @ApiOperation({
        summary: 'Exportar contenido generado por IA',
        description:
            'Descarga los campos generados por IA (aiTitle, aiDescription, aiKeywords, aiAttributes, marketplaceIds) ' +
            'para cada producto del usuario en el formato indicado (json, csv, xlsx).',
    })
    @ApiParam({
        name: 'format',
        enum: ['json', 'csv', 'xlsx'],
        description: 'Formato de exportación',
    })
    async exportAiContent(
        @Param('format') format: string,
        @Query() filters: ExportQueryDto,
        @Req() req,
        @Res() res: Response,
    ) {
        this.validateFormat(format);

        const products = await this.exportService.getProductsForExport(
            req.user.id,
            filters,
        );
        const mapped = this.exportService.mapAiContentForExport(products);

        return this.sendFile(res, mapped, 'ai_content', 'AI Content', format as ExportFormat);
    }

    // ─── Private helpers ─────────────────────────────────────────────

    private validateFormat(format: string): asserts format is ExportFormat {
        if (!VALID_FORMATS.includes(format as ExportFormat)) {
            throw new BadRequestException(
                `Formato no soportado: "${format}". Usa uno de: ${VALID_FORMATS.join(', ')}`,
            );
        }
    }

    private async sendFile(
        res: Response,
        data: Record<string, any>[],
        filenamePrefix: string,
        sheetName: string,
        format: ExportFormat,
    ) {
        let buffer: Buffer;

        switch (format) {
            case 'json':
                buffer = this.exportService.toJSON(data);
                break;
            case 'csv':
                buffer = this.exportService.toCSV(data);
                break;
            case 'xlsx':
                buffer = await this.exportService.toXLSX(data, sheetName);
                break;
        }

        const filename = this.exportService.generateFilename(filenamePrefix, format);
        const contentType = this.exportService.getContentType(format);

        res.set({
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': buffer.length,
        });

        return res.send(buffer);
    }
}
