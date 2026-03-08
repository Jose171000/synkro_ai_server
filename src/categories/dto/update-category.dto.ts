import { IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { CategoryAttribute } from '../entities/marketplace-category.entity';

class UpdateCategoryAttributeDto implements CategoryAttribute {
    @ApiProperty({ example: 'ShoeSize' })
    @IsString()
    @IsNotEmpty()
    name: string;

    @ApiProperty({ example: 'Talla del calzado en sistema US' })
    @IsString()
    @IsNotEmpty()
    description: string;

    @ApiProperty({ example: '10.5' })
    @IsString()
    @IsNotEmpty()
    example: string;

    @ApiProperty({ example: true })
    @IsBoolean()
    isRequired: boolean;
}

export class UpdateCategoryDto {
    @ApiPropertyOptional({ example: "Men's Running Shoes" })
    @IsString()
    @IsOptional()
    name?: string;

    @ApiPropertyOptional({ example: 'zapatillas running correr adidas nike deportivo' })
    @IsString()
    @IsOptional()
    labelText?: string;

    @ApiPropertyOptional({
        example: [{ name: 'ShoeSize', description: 'Talla US del calzado', example: '10.5', isRequired: true }],
        description: 'Si se actualiza labelText o los atributos, se regenera el embedding automáticamente.',
    })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => UpdateCategoryAttributeDto)
    @IsOptional()
    requiredAttributes?: CategoryAttribute[];
}
