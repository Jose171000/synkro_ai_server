import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CompletarCategoriaDeGrupoDto {
    @ApiPropertyOptional({ description: 'Categoría de Falabella para las variantes que no tienen. Si se omite, la que usan más variantes ya publicadas.' })
    @IsOptional()
    @IsString()
    @MaxLength(20)
    categoryId?: string;
}
