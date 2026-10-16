import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class SetBrandDto {
    @ApiProperty({ description: 'Marca del catálogo de Falabella (o GENERICO).', example: 'Fisher-Price' })
    @IsString()
    @IsNotEmpty({ message: 'Indica la marca.' })
    @MaxLength(120)
    brand: string;

    @ApiPropertyOptional({ description: 'Cuenta de Falabella, si la tienda tiene varias.' })
    @IsOptional()
    @IsString()
    connectionId?: string;
}
