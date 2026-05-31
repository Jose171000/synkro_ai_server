import { IsEmail, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SendTestEmailDto {
    @ApiProperty({ example: 'destino@correo.com' })
    @IsEmail()
    to: string;

    @ApiProperty({ example: 'Jose' })
    @IsString()
    @MinLength(1)
    name: string;
}
