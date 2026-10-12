import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsNumber, IsOptional, IsString, IsUrl, Max, Min, ValidateIf } from 'class-validator';
import { FRECUENCIAS, MODELOS_DE_COBRO } from '../plan-comercial';

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

    @ApiPropertyOptional({ enum: MODELOS_DE_COBRO, description: 'Cómo se le cobra: cuota fija, comisión, ambos o ninguno definido' })
    @IsOptional()
    @IsIn(MODELOS_DE_COBRO)
    billingModel?: 'ninguno' | 'fijo' | 'comision' | 'mixto';

    @ApiPropertyOptional({ example: 300, nullable: true, description: 'Cuota pactada por periodo' })
    @IsOptional()
    @ValidateIf((_, v) => v !== null)
    @IsNumber()
    @Min(0)
    monthlyFee?: number | null;

    @ApiPropertyOptional({ enum: FRECUENCIAS })
    @IsOptional()
    @IsIn(FRECUENCIAS)
    feeFrequency?: 'mensual' | 'trimestral' | 'anual';

    @ApiPropertyOptional({ example: 5, nullable: true, description: 'Porcentaje sobre sus ventas' })
    @IsOptional()
    @ValidateIf((_, v) => v !== null)
    @IsNumber()
    @Min(0)
    @Max(100)
    commissionRate?: number | null;

    @ApiPropertyOptional({ example: '2026-11-15', nullable: true, description: 'Próximo pago (YYYY-MM-DD)' })
    @IsOptional()
    @ValidateIf((_, v) => v !== null)
    @IsDateString()
    nextDueDate?: string | null;

    @ApiPropertyOptional({ example: 'PEN' })
    @IsOptional()
    @IsString()
    planCurrency?: string;

    @ApiPropertyOptional({ nullable: true })
    @IsOptional()
    @IsString()
    proposalNotes?: string | null;
}
