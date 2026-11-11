import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RenombrarEjeDto {
    @ApiProperty({ description: 'Nombre actual del eje de variación.', example: 'Talla' })
    @IsString() @MinLength(1) @MaxLength(60)
    from: string;

    @ApiProperty({ description: 'Nombre nuevo, normalmente el que pide el canal.', example: 'Tamaño cama' })
    @IsString() @MinLength(1) @MaxLength(60)
    to: string;
}
