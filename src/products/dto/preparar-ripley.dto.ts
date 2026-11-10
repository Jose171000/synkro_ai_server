import { IsBoolean, IsOptional } from 'class-validator';

export class PrepararRipleyDto {
    /** false (por defecto): vista previa, no cambia nada. true: anota el resultado en el producto (no envía nada a Ripley). */
    @IsBoolean()
    @IsOptional()
    guardar?: boolean;
}
