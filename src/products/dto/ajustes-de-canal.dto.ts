import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';

export class SugerirAjustesDto {
    @ApiProperty({ description: 'Canal cuyas listas cerradas se revisan.', example: 'falabella' })
    @IsString() @MinLength(1) @MaxLength(40)
    marketplace: string;
}

export class CambioDeAjusteDto {
    @ApiProperty({ description: 'Eje del grupo («Color»).', example: 'Color' })
    @IsString() @MinLength(1) @MaxLength(60)
    eje: string;

    @ApiProperty({ description: 'Valor que escribió la persona.', example: 'Plomo intermedio' })
    @IsString() @MinLength(1) @MaxLength(120)
    valor: string;

    @ApiProperty({ description: 'Opción válida del canal a la que corresponde.', example: 'Gris' })
    @IsString() @MinLength(1) @MaxLength(200)
    opcion: string;

    @ApiProperty({ required: false, description: 'Dato concreto del canal al que se aplica el ajuste cuando el eje tiene varios con listas distintas («Color básico»).', example: 'Color básico' })
    @IsOptional() @IsString() @MaxLength(120)
    atributo?: string;
}

export class CambioDeCorreccionDto {
    @ApiProperty({ description: 'Dato del canal que rechazó el valor («Color principal»).' })
    @IsString() @MinLength(1) @MaxLength(120)
    atributo: string;

    @ApiProperty({ description: 'Valor rechazado de la variante («Coral»).' })
    @IsString() @MinLength(1) @MaxLength(120)
    valor: string;

    @ApiProperty({ description: 'Opción de la lista del canal que se usará en su lugar.' })
    @IsString() @MinLength(1) @MaxLength(120)
    opcion: string;
}

export class AplicarCorreccionDto {
    @ApiProperty({ example: 'mercadolibre' })
    @IsString() @MinLength(1) @MaxLength(40)
    marketplace: string;

    @ApiProperty({ type: [CambioDeCorreccionDto] })
    @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => CambioDeCorreccionDto)
    cambios: CambioDeCorreccionDto[];
}

export class AplicarAjustesDto {
    @ApiProperty({ example: 'falabella' })
    @IsString() @MinLength(1) @MaxLength(40)
    marketplace: string;

    @ApiProperty({ type: [CambioDeAjusteDto] })
    @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => CambioDeAjusteDto)
    cambios: CambioDeAjusteDto[];
}
