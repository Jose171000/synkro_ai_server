import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class DuplicatesActionDto {
    @ApiPropertyOptional({ description: 'Cuenta de Mercado Libre; obligatoria si la tienda tiene varias.' })
    @IsOptional()
    @IsString()
    connectionId?: string;

    @ApiProperty({ description: 'Publicaciones repetidas a pausar o cerrar (por ejemplo MPE123456789)', type: [String] })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(100)
    @IsString({ each: true })
    @MaxLength(40, { each: true })
    externalIds: string[];
}
