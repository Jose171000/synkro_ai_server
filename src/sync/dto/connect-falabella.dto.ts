import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { PAISES_FALABELLA } from '../../common/currency';

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

    @ApiProperty({
        description:
            'País de la cuenta de Seller Center. Determina en qué moneda se ' +
            'guardan las ventas: sin él se usa la de por defecto y las cifras ' +
            'de facturación saldrían mal para un vendedor de otro país.',
        enum: PAISES_FALABELLA,
        required: false,
        default: 'PE',
    })
    @IsOptional()
    @IsString()
    @IsIn(PAISES_FALABELLA as unknown as string[], {
        message: `El país debe ser uno de: ${PAISES_FALABELLA.join(', ')}.`,
    })
    country?: string;
}
