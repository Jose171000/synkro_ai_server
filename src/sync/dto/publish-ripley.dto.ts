import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class PublishRipleyDto {
    @ApiPropertyOptional({ description: 'Se pidió desde la fila de un grupo: se publican todas sus variantes.' })
    @IsOptional()
    @IsBoolean()
    alGrupo?: boolean;

    @ApiPropertyOptional({ description: 'Confirmación EXPRESA para enviar a Ripley (la vista previa no la necesita).' })
    @IsOptional()
    @IsBoolean()
    confirmar?: boolean;

    @ApiPropertyOptional({ description: 'Solo al anotar un envío anterior: número de la importación de ofertas de Ripley.' })
    @IsOptional()
    @IsString()
    importId?: string;

    @ApiPropertyOptional({ description: 'Solo al anotar un envío anterior: número de la importación de productos de Ripley.' })
    @IsOptional()
    @IsString()
    productImportId?: string;

    @ApiPropertyOptional({ description: 'Cuenta de Ripley, si la tienda tiene varias.' })
    @IsOptional()
    @IsString()
    connectionId?: string;
}
