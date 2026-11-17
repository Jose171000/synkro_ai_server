import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsString } from 'class-validator';

export class VistaPublicacionMasivaDto {
    @ApiProperty({ description: 'Productos seleccionados (un grupo de variantes cuenta como uno)', type: [String] })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(200)
    @IsString({ each: true })
    productIds: string[];
}

export class PublicacionMasivaDto extends VistaPublicacionMasivaDto {
    @ApiProperty({ description: 'Cuentas de canal donde publicar', type: [String] })
    @IsArray()
    @ArrayMinSize(1)
    @IsString({ each: true })
    connectionIds: string[];

    @ApiProperty({ description: 'Debe ser true: publicar escribe en canales reales' })
    @IsBoolean()
    confirmar: boolean;
}
