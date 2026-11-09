import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

/** Lo que es común a todas las variantes de un grupo. El nombre, el SKU, el precio, el stock y las fotos no van aquí. */
export class UpdateProductGroupDto {
    @ApiPropertyOptional({ description: 'Descripción original del producto (la misma en todas las variantes).' })
    @IsOptional() @IsString() @MaxLength(25000)
    description?: string;

    @ApiPropertyOptional({ description: 'Categoría.' })
    @IsOptional() @IsString() @MaxLength(150)
    category?: string;

    @ApiPropertyOptional({ description: 'Subcategoría.' })
    @IsOptional() @IsString() @MaxLength(150)
    subCategory?: string;

    @ApiPropertyOptional({ description: 'Marketplaces destino.', type: [String] })
    @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true })
    targetMarketplaces?: string[];
}
