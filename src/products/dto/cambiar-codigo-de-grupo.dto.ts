import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CambiarCodigoDeGrupoDto {
    @ApiPropertyOptional({ description: 'Código nuevo del grupo. Si no se indica, se usa el siguiente código libre de la tienda.', example: '23090104' })
    @IsOptional() @IsString() @MaxLength(60)
    codigo?: string;
}
