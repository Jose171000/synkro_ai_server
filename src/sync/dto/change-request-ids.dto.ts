import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export const MAX_SOLICITUDES_A_LA_VEZ = 200;

/** Varias solicitudes de cambio de una vez (un grupo de variantes o todas las pendientes). */
export class ChangeRequestIdsDto {
    @ApiProperty({ type: [String], description: 'Solicitudes de la tienda a aprobar o rechazar.' })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(MAX_SOLICITUDES_A_LA_VEZ)
    @IsUUID('4', { each: true })
    ids: string[];

    @ApiPropertyOptional({ description: 'Motivo del rechazo (solo al rechazar).' })
    @IsOptional()
    @IsString()
    @MaxLength(300)
    reason?: string;
}
