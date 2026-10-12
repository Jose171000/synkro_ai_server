import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class ConnectWooCommerceDto {
    @ApiProperty({ description: 'Dirección de la tienda de WordPress con WooCommerce.', example: 'https://mitienda.com' })
    @IsString()
    @IsNotEmpty({ message: 'Escribe la dirección de tu tienda, por ejemplo https://mitienda.com.' })
    siteUrl: string;

    @ApiProperty({ description: 'Consumer Key (WooCommerce → Ajustes → Avanzado → API REST), con permisos de lectura y escritura.', example: 'ck_xxxxxxxx' })
    @IsString()
    @IsNotEmpty({ message: 'Pega la Consumer Key de WooCommerce.' })
    consumerKey: string;

    @ApiProperty({ description: 'Consumer Secret de la misma clave de API.', example: 'cs_xxxxxxxx' })
    @IsString()
    @IsNotEmpty({ message: 'Pega el Consumer Secret de WooCommerce.' })
    consumerSecret: string;

    @ApiProperty({ description: 'Nombre para distinguir esta cuenta de otras del mismo canal.', required: false, example: 'Tienda web' })
    @IsOptional()
    @IsString()
    @MaxLength(60)
    label?: string;
}
