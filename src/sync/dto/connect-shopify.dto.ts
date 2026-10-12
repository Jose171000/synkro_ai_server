import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class ConnectShopifyDto {
    @ApiProperty({ description: 'Dominio de la tienda en Shopify (el .myshopify.com).', example: 'mitienda.myshopify.com' })
    @IsString()
    @IsNotEmpty({ message: 'Escribe el dominio de tu tienda, por ejemplo mitienda.myshopify.com.' })
    shop: string;

    @ApiProperty({ description: 'Token de acceso de la Admin API de una app personalizada (empieza por shpat_).', example: 'shpat_xxxxxxxx' })
    @IsString()
    @IsNotEmpty({ message: 'Pega el token de acceso de la Admin API de Shopify.' })
    accessToken: string;

    @ApiProperty({ description: 'Nombre para distinguir esta cuenta de otras del mismo canal.', required: false, example: 'Tienda online' })
    @IsOptional()
    @IsString()
    @MaxLength(60)
    label?: string;
}
