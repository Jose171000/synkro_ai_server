import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class ConnectRipleyDto {
    @ApiProperty({ description: 'Clave de API de la tienda en Mercado Ripley (portal de vendedor › tu correo › Configuración › Clave API).' })
    @IsString()
    @IsNotEmpty({ message: 'Pega la clave de API de Mercado Ripley.' })
    @MaxLength(300)
    apiKey: string;

    @ApiProperty({
        description: 'Dirección del portal de vendedor (*.mirakl.net). Si se deja vacía se usa la de Perú.',
        required: false,
        example: 'ripleyperu-prod.mirakl.net',
    })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    site?: string;

    @ApiProperty({ description: 'Nombre para distinguir esta cuenta de otras del mismo canal.', required: false, example: 'Ripley Perú' })
    @IsOptional()
    @IsString()
    @MaxLength(60)
    label?: string;
}
