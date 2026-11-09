import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const MAX_REENVIOS_DE_STOCK = 200;

export class ResendStockMasivoDto {
    @ApiProperty({ description: 'Publicaciones (una por producto y canal) a las que se vuelve a mandar el stock de Synkro.', type: [String] })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(MAX_REENVIOS_DE_STOCK)
    @IsString({ each: true })
    @MaxLength(60, { each: true })
    listingIds: string[];

    @ApiProperty({ description: 'Qué se reenvía: el stock (por defecto) o el precio (solo Ripley).', enum: ['stock', 'price'], required: false })
    @IsOptional()
    @IsIn(['stock', 'price'])
    campo?: 'stock' | 'price';
}
