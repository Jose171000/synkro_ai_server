import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsNumber, IsObject, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';

class MeasuresDto {
    @IsNumber() @Min(1) width: number;
    @IsNumber() @Min(1) length: number;
    @IsNumber() @Min(1) height: number;
    @IsNumber() @Min(0.001) weight: number;
}

/** Precio y descuento propios de una cuenta. Un valor en null (o ausente) vuelve a usar el del producto. */
export class ChannelPriceDto {
    @IsString() connectionId: string;
    @IsOptional() @IsNumber() @Min(0.01) price?: number | null;
    @IsOptional() @IsNumber() @Min(0.01) salePrice?: number | null;
    @IsOptional() @IsString() saleStart?: string | null;
    @IsOptional() @IsString() saleEnd?: string | null;
}

/** Cambios sobre la ficha de un producto. Todo es opcional: solo se guarda lo que se envía. */
export class SaveSheetDto {
    @ApiPropertyOptional({ description: 'Nombre del producto.' })
    @IsOptional() @IsString() @MaxLength(300)
    name?: string;

    @ApiPropertyOptional({ description: 'Descripción original del producto (texto del cliente).' })
    @IsOptional() @IsString() @MaxLength(25000)
    description?: string;

    @ApiPropertyOptional({ description: 'Título optimizado que se envía a los canales.' })
    @IsOptional() @IsString() @MaxLength(300)
    aiTitle?: string;

    @ApiPropertyOptional({ description: 'Descripción en texto plano (Mercado Libre y otros).' })
    @IsOptional() @IsString() @MaxLength(25000)
    aiDescription?: string;

    @ApiPropertyOptional({ description: 'Descripción HTML estándar (Falabella y canales con HTML). Vacía para quitarla.' })
    @IsOptional() @IsString() @MaxLength(25000)
    descriptionHtml?: string;

    @ApiPropertyOptional({ description: 'Marca.' })
    @IsOptional() @IsString() @MaxLength(120)
    brand?: string;

    @ApiPropertyOptional({ description: 'Atributos de la categoría de Falabella por nombre técnico. Un valor vacío lo quita.' })
    @IsOptional() @IsObject()
    attributes?: Record<string, string>;

    @ApiPropertyOptional({ description: 'Atributos de Mercado Libre por id (COLOR, MATERIAL…). Un valor vacío lo quita.' })
    @IsOptional() @IsObject()
    mercadolibreAttributes?: Record<string, string>;

    @ApiPropertyOptional({ description: 'Medidas del paquete en cm y kg.' })
    @IsOptional() @ValidateNested() @Type(() => MeasuresDto)
    measures?: MeasuresDto;

    @ApiPropertyOptional({ description: 'Precio y descuento propios de cada cuenta. Se envían a su canal, no al contenido.' })
    @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ChannelPriceDto)
    prices?: ChannelPriceDto[];
}
