import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';

/** Cuántos productos caben en una eliminación masiva. */
export const MAX_ELIMINACION_MASIVA = 200;

export class EliminarVariosDto {
    @ApiProperty({ description: 'Productos a eliminar (si es una variante, solo ella; para un grupo completo van los ids de todas sus variantes)', type: [String] })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(MAX_ELIMINACION_MASIVA)
    @IsUUID('4', { each: true })
    ids: string[];
}
