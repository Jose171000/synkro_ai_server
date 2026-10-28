import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class VincularVarianteDto {
    @ApiProperty({ description: 'Producto de Synkro.' })
    @IsUUID()
    productId: string;

    @ApiProperty({ description: 'Id de la variante en Yavendió.' })
    @IsString()
    @IsNotEmpty()
    variantId: string;
}

export class VincularYavendioDto {
    @ApiPropertyOptional({ description: 'Cuenta de Yavendió. Obligatoria si la tienda tiene más de una.' })
    @IsOptional()
    @IsString()
    connectionId?: string;

    @ApiProperty({ type: [VincularVarianteDto], description: 'Pares ya confirmados por la persona.' })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(500)
    @ValidateNested({ each: true })
    @Type(() => VincularVarianteDto)
    links: VincularVarianteDto[];
}

export class ImportarPedidosYavendioDto {
    @ApiPropertyOptional({ description: 'Cuenta de Yavendió. Obligatoria si la tienda tiene más de una.' })
    @IsOptional()
    @IsString()
    connectionId?: string;

    @ApiPropertyOptional({ description: 'Solo cuenta qué entraría, sin guardar.', default: false })
    @IsOptional()
    @IsBoolean()
    dryRun?: boolean;

    @ApiPropertyOptional({ description: 'Días hacia atrás que se revisan.', default: 90 })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(3650)
    dias?: number;
}
