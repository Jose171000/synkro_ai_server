import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsObject, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';

export class ManualVariantDto {
    @ApiProperty({ description: 'SKU del producto (ya importado en la tienda)' })
    @IsString()
    @MaxLength(200)
    sellerSku: string;

    @ApiProperty({ description: 'Valor de cada eje para este SKU', example: { Color: 'Rosa', Talla: 'King' } })
    @IsObject()
    values: Record<string, string>;
}

export class ManualVariantGroupDto {
    @ApiProperty({ description: 'Código del grupo (en Falabella, el ParentSku)' })
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    parentSku: string;

    @ApiProperty({ description: 'Nombre del producto con variantes' })
    @IsString()
    @MinLength(1)
    @MaxLength(250)
    name: string;

    @ApiProperty({ description: 'Nombres de los ejes de variación (de 1 a 3)', example: ['Color'] })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(3)
    @IsString({ each: true })
    axes: string[];

    @ApiProperty({ type: [ManualVariantDto] })
    @IsArray()
    @ArrayMinSize(2)
    @ArrayMaxSize(100)
    @ValidateNested({ each: true })
    @Type(() => ManualVariantDto)
    variants: ManualVariantDto[];
}
