import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ListingPromoDto {
    @ApiProperty({ description: 'Precio con descuento de ESTA cuenta. Vacío o nulo: quita el descuento.', required: false, nullable: true })
    @IsOptional()
    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(0)
    @Max(10_000_000)
    salePrice?: number | null;

    @ApiProperty({ description: 'Desde (AAAA-MM-DD), opcional.', required: false, nullable: true })
    @IsOptional()
    @IsString()
    @MaxLength(10)
    saleStart?: string | null;

    @ApiProperty({ description: 'Hasta (AAAA-MM-DD), opcional.', required: false, nullable: true })
    @IsOptional()
    @IsString()
    @MaxLength(10)
    saleEnd?: string | null;
}
