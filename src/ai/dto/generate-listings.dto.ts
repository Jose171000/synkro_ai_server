import { IsArray, IsBoolean, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { CategoryAttribute } from '../../categories/entities/marketplace-category.entity';

export class GenerateListingsDto {
    @ApiProperty({
        description: 'Nombre o título principal del producto base',
        example: 'Zapatillas deportivas para running',
    })
    @IsString()
    @IsNotEmpty()
    productName: string;

    @ApiProperty({
        description: 'Descripción básica o características iniciales que proporcionó el usuario',
        example: 'Son de color rojo, con suela ultra ligera y cordones ajustables.',
    })
    @IsString()
    @IsNotEmpty()
    description: string;

    @ApiProperty({
        description: 'Arreglo con las llaves de los marketplaces destino (amazon, mercadolibre, shopify...)',
        example: ['amazon', 'mercadolibre'],
    })
    @IsArray()
    @IsString({ each: true })
    @IsNotEmpty()
    targetMarketplaces: string[];

    @ApiProperty({
        description: 'Atributos extraídos, detalles técnicos opcionales',
        example: { color: 'Rojo', material: 'Malla transpirable' },
        required: false,
    })
    @IsObject()
    @IsOptional()
    extractedAttributes?: Record<string, any>;

    @ApiProperty({
        description: 'Diccionario con los campos requeridos obligatorios. La key es el marketplace, y el array los campos a deducir.',
        example: { amazon: ['ShoeSize', 'OuterMaterialType', 'DepartmentName'], mercadolibre: ['Material del interior', 'Género'] },
        required: false,
    })
    @IsObject()
    @IsOptional()
    categoryRequirements?: Record<string, CategoryAttribute[]>;

    @ApiProperty({
        description: 'Modo masivo: los datos obligatorios que no se puedan deducir se estiman en vez de quedar vacíos.',
        required: false,
    })
    @IsBoolean()
    @IsOptional()
    estimateMissing?: boolean;
}
