import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';

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
}

export class AplicarAjustesDto {
    @ApiProperty({ example: 'falabella' })
    @IsString() @MinLength(1) @MaxLength(40)
    marketplace: string;

    @ApiProperty({ type: [CambioDeAjusteDto] })
    @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => CambioDeAjusteDto)
    cambios: CambioDeAjusteDto[];
}
