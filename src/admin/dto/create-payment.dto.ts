import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreatePaymentDto {
    @ApiProperty({ example: 1500.00 })
    @IsNumber()
    @Min(0.01)
    amount: number;

    @ApiPropertyOptional({ example: 'PEN', default: 'PEN' })
    @IsOptional()
    @IsString()
    currency?: string;

    @ApiProperty({ enum: ['unico', 'recurrente'] })
    @IsIn(['unico', 'recurrente'])
    type: 'unico' | 'recurrente';

    @ApiPropertyOptional({ enum: ['mensual', 'trimestral', 'anual'], description: 'Solo para pagos recurrentes' })
    @IsOptional()
    @IsIn(['mensual', 'trimestral', 'anual'])
    frequency?: string;

    @ApiProperty({ example: 'Retainer agencia — julio 2026' })
    @IsString()
    @IsNotEmpty()
    concept: string;

    @ApiPropertyOptional({ example: 'transferencia' })
    @IsOptional()
    @IsString()
    method?: string;

    @ApiProperty({ example: '2026-07-22', description: 'Fecha del pago (YYYY-MM-DD)' })
    @IsDateString()
    paidAt: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    notes?: string;
}
