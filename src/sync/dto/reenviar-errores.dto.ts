import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/** Qué envíos con error rehacer: unos concretos, o todos los que coinciden con los filtros del historial. */
export class ReenviarErroresDto {
    @ApiPropertyOptional({ type: [String] })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(200)
    @IsUUID('4', { each: true })
    ids?: string[];

    @ApiPropertyOptional({ enum: ['price', 'stock', 'promo'] })
    @IsOptional()
    @IsIn(['price', 'stock', 'promo'])
    field?: string;

    @ApiPropertyOptional({ description: 'SKU o nombre del producto.' })
    @IsOptional()
    @IsString()
    @MaxLength(120)
    q?: string;
}
