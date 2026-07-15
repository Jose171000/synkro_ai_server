import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, Min } from 'class-validator';

export class UpdateInventoryDto {
    @ApiPropertyOptional({ description: 'Nuevo stock disponible', example: 25 })
    @IsOptional()
    @IsInt()
    @Min(0)
    stock?: number;

    @ApiPropertyOptional({ description: 'Nuevo precio', example: 149.9 })
    @IsOptional()
    @IsNumber()
    @Min(0)
    price?: number;
}
