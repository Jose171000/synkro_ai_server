import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class ConnectFalabellaDto {
    @ApiProperty({
        description: 'UserID del Seller Center: es el correo de la cuenta.',
        example: 'vendedor@miempresa.com',
    })
    @IsString()
    @IsNotEmpty({ message: 'Escribe el UserID (el correo de tu cuenta de Seller Center).' })
    userId: string;

    @ApiProperty({ description: 'API key generada en el Seller Center de Falabella.' })
    @IsString()
    @IsNotEmpty({ message: 'Pega la API key de Falabella.' })
    apiKey: string;
}
