import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class SaveRipleyPreparationDto {
    @ApiPropertyOptional({ description: 'Código de la categoría de Ripley elegida (de las importadas).', example: 'R141100000000' })
    @IsOptional()
    @IsString()
    @MaxLength(60)
    categoryId?: string;

    @ApiPropertyOptional({ description: 'Valores de los atributos de la categoría ({ código: valor }). Un valor vacío borra el atributo.' })
    @IsOptional()
    @IsObject()
    attributes?: Record<string, string>;

    @ApiPropertyOptional({ description: 'Nombre de Ripley (máx. 125, se guarda en MAYÚSCULAS) y descripción corta.' })
    @IsOptional()
    @IsObject()
    content?: { name?: string; shortDescription?: string };
}
