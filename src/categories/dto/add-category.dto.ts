import { IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { CategoryAttribute } from '../entities/marketplace-category.entity';

class CategoryAttributeDto implements CategoryAttribute {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsString()
    @IsNotEmpty()
    description: string;

    @IsString()
    @IsNotEmpty()
    example: string;

    @IsBoolean()
    isRequired: boolean;
}

export class AddCategoryDto {
    @ApiProperty({ example: 'amazon', description: 'Target marketplace identifier' })
    @IsString()
    @IsNotEmpty()
    marketplace: string;

    @ApiProperty({ example: 'shoes_running', description: 'Unique category ID for this marketplace' })
    @IsString()
    @IsNotEmpty()
    categoryId: string;

    @ApiProperty({ example: "Men's Running Shoes", description: 'Human-readable category name' })
    @IsString()
    @IsNotEmpty()
    name: string;

    @ApiProperty({
        example: 'zapatillas running correr deportivo tenis adidas nike',
        description: 'Rich keyword text used to generate the semantic embedding',
    })
    @IsString()
    @IsNotEmpty()
    labelText: string;

    @ApiPropertyOptional({
        example: [{ name: 'ShoeSize', description: 'Talla US del calzado', example: '10.5' }],
        description: 'Required attributes for listings in this category, with descriptions and examples for the LLM',
    })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CategoryAttributeDto)
    @IsOptional()
    requiredAttributes?: CategoryAttribute[];
}

