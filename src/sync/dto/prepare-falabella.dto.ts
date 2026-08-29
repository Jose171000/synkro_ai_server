import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, Min } from 'class-validator';

export class PrepareFalabellaDto {
    @ApiProperty({ description: 'Categoría de Falabella donde se publicará.', example: '2804' })
    @IsString()
    @IsNotEmpty({ message: 'Elige la categoría de Falabella.' })
    categoryId: string;

    @ApiProperty({ description: 'Ancho del paquete en centímetros.' })
    @IsInt()
    @Min(1, { message: 'El ancho debe ser mayor que cero.' })
    packageWidth: number;

    @ApiProperty({ description: 'Largo del paquete en centímetros.' })
    @IsInt()
    @Min(1, { message: 'El largo debe ser mayor que cero.' })
    packageLength: number;

    @ApiProperty({ description: 'Alto del paquete en centímetros.' })
    @IsInt()
    @Min(1, { message: 'El alto debe ser mayor que cero.' })
    packageHeight: number;

    @ApiProperty({ description: 'Peso del paquete en kilos.' })
    @IsNumber()
    @Min(0.001, { message: 'El peso debe ser mayor que cero.' })
    packageWeight: number;

    @ApiPropertyOptional({
        description: 'Atributos propios de la categoría, por su nombre técnico (ej. tipo_automotriz).',
    })
    @IsOptional()
    @IsObject()
    attributes?: Record<string, string>;
}
