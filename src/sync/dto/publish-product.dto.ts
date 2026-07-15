import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsIn, ArrayNotEmpty } from 'class-validator';

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
}
