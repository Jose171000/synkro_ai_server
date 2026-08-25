import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsDateString,
    IsIn,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    Matches,
    Max,
    Min,
} from 'class-validator';

export class UpsertBillingDto {
    @ApiProperty({ description: 'ID del cliente' })
    @IsString()
    @IsNotEmpty()
    clientId: string;

    @ApiProperty({ example: '2026-08', description: 'Periodo en formato YYYY-MM' })
    @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'El periodo debe tener el formato YYYY-MM' })
    period: string;

    @ApiProperty({ example: 45000.5, description: 'Ventas totales del cliente en el periodo' })
    @IsNumber()
    @Min(0)
    totalSales: number;

    @ApiProperty({ example: 8.5, description: 'Porcentaje de comisión pactado' })
    @IsNumber()
    @Min(0)
    @Max(100, { message: 'La comisión no puede superar el 100%' })
    commissionRate: number;

    @ApiPropertyOptional({ example: 'PEN', default: 'PEN' })
    @IsOptional()
    @IsString()
    currency?: string;

    @ApiPropertyOptional({ enum: ['manual', 'sheets', 'marketplaces'], default: 'manual' })
    @IsOptional()
    @IsIn(['manual', 'sheets', 'marketplaces'])
    salesSource?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    notes?: string;
}

export class UpdateBillingStatusDto {
    @ApiPropertyOptional({ enum: ['pendiente', 'facturado', 'cobrado'] })
    @IsOptional()
    @IsIn(['pendiente', 'facturado', 'cobrado'])
    status?: 'pendiente' | 'facturado' | 'cobrado';

    @ApiPropertyOptional({ example: 'F001-00000123' })
    @IsOptional()
    @IsString()
    invoiceRef?: string;

    @ApiPropertyOptional({ example: '2026-09-05' })
    @IsOptional()
    @IsDateString()
    invoicedAt?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    notes?: string;
}
