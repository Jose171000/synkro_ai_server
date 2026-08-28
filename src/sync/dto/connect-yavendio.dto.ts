import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class ConnectYavendioDto {
    @ApiProperty({
        description: 'API key generada en el panel de Yavendió (Configuración → Claves API).',
        example: 'yv_live_v1_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    })
    @IsString()
    @IsNotEmpty({ message: 'Pega la API key de Yavendió para conectar la cuenta.' })
    apiKey: string;
}
