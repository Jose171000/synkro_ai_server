import { IsOptional, IsString, IsNumber, IsBoolean } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ExportQueryDto {
    @ApiPropertyOptional({ description: 'Buscar por nombre, SKU o descripción' })
    @IsOptional()
    @IsString()
    search?: string;

    @ApiPropertyOptional({ description: 'Filtrar por marketplace (ej. amazon, mercadolibre)' })
    @IsOptional()
    @IsString()
    marketplace?: string;

    @ApiPropertyOptional({ description: 'Filtrar por categoría' })
    @IsOptional()
    @IsString()
    category?: string;

    @ApiPropertyOptional({ description: 'Filtrar por subcategoría' })
    @IsOptional()
    @IsString()
    subCategory?: string;

    @ApiPropertyOptional({ description: 'Precio mínimo' })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    minPrice?: number;

    @ApiPropertyOptional({ description: 'Precio máximo' })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    maxPrice?: number;

    @ApiPropertyOptional({ description: 'Solo productos con stock > 0' })
    @IsOptional()
    @Transform(({ value }) => value === 'true' || value === true)
    @IsBoolean()
    inStock?: boolean;
}
