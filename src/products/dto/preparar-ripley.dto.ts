import { IsBoolean, IsOptional } from 'class-validator';

export class PrepararRipleyDto {
    /** false (por defecto): vista previa, no cambia nada. true: anota el resultado en el producto (no envía nada a Ripley). */
    @IsBoolean()
    @IsOptional()
    guardar?: boolean;

    /** Se pidió desde la fila de un grupo de variantes: se analizan la información general, las fotos de todas (hasta el límite) y todos los ejes. */
    @IsBoolean()
    @IsOptional()
    alGrupo?: boolean;
}
