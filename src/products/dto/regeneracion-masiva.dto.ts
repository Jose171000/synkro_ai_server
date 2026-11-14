import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString } from 'class-validator';

export class RegeneracionMasivaDto {
    @ApiProperty({ description: 'Productos seleccionados (un grupo de variantes cuenta como uno)', type: [String] })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(200)
    @IsString({ each: true })
    productIds: string[];

    @ApiPropertyOptional({ type: [String] })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    targetMarketplaces?: string[];

    @ApiPropertyOptional({ description: 'Tono de la redacción (p. ej. «profesional»)' })
    @IsOptional()
    @IsString()
    tone?: string;
}
