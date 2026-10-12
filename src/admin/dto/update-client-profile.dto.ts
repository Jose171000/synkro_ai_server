import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUrl } from 'class-validator';

export class UpdateClientProfileDto {
    @ApiPropertyOptional({ example: '20601234567' })
    @IsOptional()
    @IsString()
    ruc?: string;

    @ApiPropertyOptional({ example: 'Rivesi SAC' })
    @IsOptional()
    @IsString()
    businessName?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    fiscalAddress?: string;

    @ApiPropertyOptional({ enum: ['agency', 'saas'] })
    @IsOptional()
    @IsIn(['agency', 'saas'])
    clientType?: 'agency' | 'saas';

    @ApiPropertyOptional({ enum: ['activo', 'pausado', 'perdido'] })
    @IsOptional()
    @IsIn(['activo', 'pausado', 'perdido'])
    status?: 'activo' | 'pausado' | 'perdido';

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    contactName?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    contactPhone?: string;

    @ApiPropertyOptional({ description: 'URL del Google Sheet publicado como CSV para alimentar el reporte del cliente' })
    @IsOptional()
    // require_tld: false permite también endpoints internos/self-hosted del equipo
    @IsUrl({ require_tld: false })
    sheetCsvUrl?: string;

    @ApiPropertyOptional({
        description: 'URL del reporte externo (AppScript, Looker Studio) que se embebe en las Analíticas del cliente',
    })
    @IsOptional()
    @IsUrl({ require_tld: false })
    reportEmbedUrl?: string;

    @ApiPropertyOptional({ description: 'Título de la pestaña del reporte embebido', example: 'Reporte de ventas' })
    @IsOptional()
    @IsString()
    reportEmbedTitle?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    notes?: string;
}
