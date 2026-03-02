import { IsString, IsNotEmpty, IsOptional, IsNumber, IsArray } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProductWithAiDto {
    @ApiProperty({ example: 'NK-001', description: 'SKU único del producto' })
    @IsString()
    @IsNotEmpty()
    sku: string;

    @ApiProperty({ example: 'Zapatillas Nike Air Max', description: 'Nombre del producto' })
    @IsString()
    @IsNotEmpty()
    name: string;

    @ApiProperty({ example: 'Zapatillas deportivas de color azul, talla 43, para correr.', description: 'Descripción del producto' })
    @IsString()
    @IsNotEmpty()
    description: string;

    @ApiPropertyOptional({ example: 'Calzado', description: 'Categoría del producto (ayuda a la IA a categorizar mejor)' })
    @IsString()
    @IsOptional()
    category?: string;

    @ApiPropertyOptional({ example: 'Tenis de correr', description: 'Subcategoría del producto' })
    @IsString()
    @IsOptional()
    subCategory?: string;

    @ApiPropertyOptional({ example: 99.99, description: 'Precio del producto' })
    @IsNumber()
    @IsOptional()
    price?: number;

    @ApiPropertyOptional({ example: 50, description: 'Stock disponible' })
    @IsNumber()
    @IsOptional()
    stock?: number;

    @ApiPropertyOptional({ example: ['amazon', 'mercadolibre'], description: 'Marketplaces objetivo para la generación de contenido IA' })
    @IsArray()
    @IsOptional()
    targetMarketplaces?: string[];

    @ApiPropertyOptional({ example: ['https://img.example.com/zapatilla.jpg'], description: 'URLs de imágenes del producto' })
    @IsArray()
    @IsOptional()
    images?: string[];

    @ApiPropertyOptional({ example: 'professional', description: 'Tono de escritura para la IA (professional, casual, persuasive)' })
    @IsString()
    @IsOptional()
    tone?: string;
}
