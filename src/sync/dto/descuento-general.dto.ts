import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsNumber, IsOptional, IsString, Matches } from 'class-validator';

export class DescuentoGeneralDto {
    @ApiProperty({ description: 'Productos (variantes) a los que se aplica el mismo descuento', type: [String] })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(500)
    @IsString({ each: true })
    productIds: string[];

    @ApiProperty({ enum: ['precio', 'porcentaje'], description: '«precio»: precio con descuento en soles. «porcentaje»: % a rebajar del precio regular.' })
    @IsIn(['precio', 'porcentaje'])
    modo: 'precio' | 'porcentaje';

    @ApiProperty({ description: 'El precio con descuento (modo precio) o el porcentaje (modo porcentaje)', example: 15 })
    @IsNumber({ maxDecimalPlaces: 2 })
    valor: number;

    @ApiPropertyOptional({ description: 'Inicio, AAAA-MM-DD (por defecto hoy)', example: '2026-11-20' })
    @IsOptional()
    @IsString()
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'La fecha de inicio debe ser AAAA-MM-DD' })
    desde?: string;

    @ApiProperty({ description: 'Fin, AAAA-MM-DD (obligatoria; puede ser dentro de un año)', example: '2027-11-13' })
    @IsString()
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'La fecha de fin debe ser AAAA-MM-DD' })
    hasta: string;
}

export class QuitarDescuentoGeneralDto {
    @ApiProperty({ type: [String] })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(500)
    @IsString({ each: true })
    productIds: string[];
}
