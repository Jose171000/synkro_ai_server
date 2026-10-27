import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class LinkMeliListingDto {
    @ApiProperty({ description: 'Cuenta de Mercado Libre donde está la publicación.' })
    @IsString()
    @IsNotEmpty()
    connectionId: string;

    @ApiProperty({ description: 'Id de la publicación que ya existe en Mercado Libre.', example: 'MPE1104343054' })
    @IsString()
    @Matches(/^[A-Z]{3}\d+$/, { message: 'El id de la publicación es como MPE1104343054.' })
    itemId: string;
}
