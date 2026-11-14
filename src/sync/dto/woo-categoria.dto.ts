import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsUUID, Min } from 'class-validator';

export class WooCategoriaDto {
    @ApiProperty({ required: false, description: 'Tienda WooCommerce. Obligatoria si la tienda de Synkro tiene varias.' })
    @IsOptional()
    @IsUUID()
    connectionId?: string;

    @ApiProperty({ required: false, description: 'Id de la categoría de WooCommerce. Sin él, Synkro elige sola de nuevo (por texto o con IA) entre las de la tienda.' })
    @IsOptional()
    @IsInt()
    @Min(1)
    categoryId?: number;
}
