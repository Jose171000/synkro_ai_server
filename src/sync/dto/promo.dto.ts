import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, Matches, Min, ValidateIf } from 'class-validator';

export class PromoDto {
    @ApiProperty({ description: 'Precio con descuento (menor que el regular); null para quitarlo', example: 199.9, nullable: true })
    @ValidateIf((_, value) => value !== null)
    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(0)
    salePrice: number | null;

    @ApiPropertyOptional({ description: 'Inicio de la promoción, AAAA-MM-DD', example: '2026-11-01', nullable: true })
    @IsOptional()
    @IsString()
    @Matches(/^\d{4}-\d{2}-\d{2}/, { message: 'La fecha de inicio debe ser AAAA-MM-DD' })
    saleStartDate?: string | null;

    @ApiPropertyOptional({ description: 'Fin de la promoción, AAAA-MM-DD', example: '2026-11-30', nullable: true })
    @IsOptional()
    @IsString()
    @Matches(/^\d{4}-\d{2}-\d{2}/, { message: 'La fecha de fin debe ser AAAA-MM-DD' })
    saleEndDate?: string | null;
}
