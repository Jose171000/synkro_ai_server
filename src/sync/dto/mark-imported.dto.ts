import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';

export const CANALES_DE_IMPORTACION = ['falabella', 'mercadolibre', 'woocommerce', 'shopify'] as const;

export class MarkImportedDto {
    @ApiProperty({ description: 'Canal del que se importaron los productos.', enum: CANALES_DE_IMPORTACION })
    @IsIn(CANALES_DE_IMPORTACION)
    channel: (typeof CANALES_DE_IMPORTACION)[number];

    @ApiPropertyOptional({ description: 'Sin true solo cuenta cuántos productos se marcarían y no escribe nada.' })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;
}
