import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsIn, IsNumber, IsOptional, IsString, Max, Min, ValidateIf } from 'class-validator';
import { FRECUENCIAS, MODELOS_DE_COBRO } from '../../admin/plan-comercial';

/** El plan comercial de una tienda (cada tienda es un cliente de la agencia). */
export class UpdateStorePlanDto {
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

    @ApiPropertyOptional({ example: 5, nullable: true, description: 'Porcentaje sobre las ventas (solo precio de productos)' })
    @IsOptional()
    @ValidateIf((_, v) => v !== null)
    @IsNumber()
    @Min(0)
    @Max(100)
    commissionRate?: number | null;

    @ApiPropertyOptional({ example: '2026-11-15', nullable: true, description: 'Próximo cobro (YYYY-MM-DD)' })
    @IsOptional()
    @ValidateIf((_, v) => v !== null)
    @IsDateString()
    nextDueDate?: string | null;

    @ApiPropertyOptional({ example: 'PEN' })
    @IsOptional()
    @IsString()
    planCurrency?: string;

    @ApiPropertyOptional({ description: 'La cuota pactada ya incluye IGV (false: el IGV va aparte)' })
    @IsOptional()
    @IsBoolean()
    feeIncludesIgv?: boolean;

    @ApiPropertyOptional({ description: 'La comisión pactada ya incluye IGV (false: el IGV va aparte)' })
    @IsOptional()
    @IsBoolean()
    commissionIncludesIgv?: boolean;

    @ApiPropertyOptional({ example: '2026-10-01', nullable: true, description: 'Desde cuándo rige el plan (YYYY-MM-DD)' })
    @IsOptional()
    @ValidateIf((_, v) => v !== null)
    @IsDateString()
    planStartDate?: string | null;

    @ApiPropertyOptional({ nullable: true })
    @IsOptional()
    @IsString()
    proposalNotes?: string | null;
}
