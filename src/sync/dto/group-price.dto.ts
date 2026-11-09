import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Max, Min } from 'class-validator';

/** El precio del producto para todas las variantes de un grupo. */
export class GroupPriceDto {
    @ApiProperty({ description: 'Precio nuevo para todas las variantes.' })
    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(0.01)
    @Max(10_000_000)
    price: number;
}
