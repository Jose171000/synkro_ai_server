import { IsBoolean, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class RellenarRipleyDto {
    /** La categoría de Ripley YA elegida (no se cambia ni se vuelve a elegir). */
    @IsString()
    @MaxLength(60)
    categoryId: string;

    /** Lo que ya está escrito en la pantalla: no se pisa ni se vuelve a pedir. */
    @IsObject()
    @IsOptional()
    actuales?: Record<string, string>;

    /** La pantalla se abrió desde la fila de un grupo de variantes: se analizan las fotos de todas y todos sus ejes. */
    @IsBoolean()
    @IsOptional()
    alGrupo?: boolean;
}
