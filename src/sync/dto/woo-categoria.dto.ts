import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsUUID, Min } from 'class-validator';

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

    @ApiProperty({ required: false, description: 'true: vuelve a elegir sola aunque ya haya una elegida (también una fijada a mano). Sin él, se reutiliza la elegida.' })
    @IsOptional()
    @IsBoolean()
    reelegir?: boolean;
}
