import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsIn, ArrayNotEmpty, IsObject, IsOptional } from 'class-validator';

export class PublishProductDto {
    @ApiProperty({
        description: 'Marketplaces donde publicar el producto',
        example: ['mercadolibre'],
        isArray: true,
    })
    @IsArray()
    @ArrayNotEmpty()
    @IsIn(['mercadolibre'], { each: true, message: 'Por ahora solo se soporta mercadolibre' })
    marketplaces: string[];

    @ApiProperty({
        description: 'Cuenta a usar por cada marketplace ({ mercadolibre: <id de la cuenta> }). Obligatoria si la tienda tiene varias cuentas del canal.',
        required: false,
        example: { mercadolibre: '3f2c1c7e-0000-4000-8000-000000000000' },
    })
    @IsOptional()
    @IsObject()
    connectionIds?: Record<string, string>;
}
