import { IsOptional, IsString, IsNumber, IsBoolean, Min, Max } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';

export class QueryProductsDto {
    @ApiPropertyOptional({ description: 'Número de página (empieza en 1)', default: 1, example: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @Min(1)
    page?: number = 1;

    @ApiPropertyOptional({ description: 'Resultados por página (máx. 100)', default: 20, example: 20 })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @Min(1)
    @Max(100)
    limit?: number = 20;

    @ApiPropertyOptional({ description: 'Texto libre — busca en nombre, SKU y descripción', example: 'zapatillas' })
    @IsOptional()
    @IsString()
    search?: string;

    @ApiPropertyOptional({ description: 'Filtrar por marketplace', example: 'amazon' })
    @IsOptional()
    @IsString()
    marketplace?: string;

    @ApiPropertyOptional({ description: 'Filtrar por categoría exacta', example: 'Calzado' })
    @IsOptional()
    @IsString()
    category?: string;

    @ApiPropertyOptional({ description: 'Filtrar por subcategoría exacta', example: 'Tenis de correr' })
    @IsOptional()
    @IsString()
    subCategory?: string;

    @ApiPropertyOptional({ description: 'Precio mínimo', example: 10 })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @Min(0)
    minPrice?: number;

    @ApiPropertyOptional({ description: 'Precio máximo', example: 500 })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @Min(0)
    maxPrice?: number;

    @ApiPropertyOptional({ description: 'Solo productos con stock > 0', example: true })
    @IsOptional()
    @Transform(({ value }) => value === 'true' || value === true)
    @IsBoolean()
    inStock?: boolean;

    @ApiPropertyOptional({
        description: 'Campo por el que ordenar',
        enum: ['createdAt', 'name', 'price', 'stock', 'sku'],
        default: 'createdAt',
        example: 'price',
    })
    @IsOptional()
    @IsString()
    sortBy?: 'createdAt' | 'name' | 'price' | 'stock' | 'sku' = 'createdAt';

    @ApiPropertyOptional({ description: 'Dirección del ordenamiento', enum: ['asc', 'desc'], default: 'desc', example: 'asc' })
    @IsOptional()
    @IsString()
    order?: 'asc' | 'desc' = 'desc';
}
