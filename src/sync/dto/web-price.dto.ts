import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Min, ValidateIf } from 'class-validator';

export class WebPriceDto {
    @ApiProperty({ description: 'Precio con descuento de la tienda web; null para quitarlo', example: 129.9, nullable: true })
    @ValidateIf((_, value) => value !== null)
    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(0)
    webPrice: number | null;
}
