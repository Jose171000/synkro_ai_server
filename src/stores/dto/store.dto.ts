import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateStoreDto {
    @ApiProperty({ example: 'Rivesi Home' })
    @IsString()
    @MinLength(2)
    @MaxLength(120)
    name: string;
}

export class InviteDto {
    @ApiProperty({ example: 'persona@correo.com' })
    @IsEmail()
    email: string;

    @ApiProperty({ enum: ['editor', 'viewer'], description: 'editor propone cambios; viewer solo mira' })
    @IsIn(['editor', 'viewer'])
    role: 'editor' | 'viewer';
}

export class ChangeRoleDto {
    @ApiProperty({ enum: ['editor', 'viewer'] })
    @IsIn(['editor', 'viewer'])
    role: 'editor' | 'viewer';
}

export class AcceptInvitationDto {
    @ApiProperty({ description: 'Código que viaja en el enlace del correo' })
    @IsString()
    @MinLength(20)
    @MaxLength(200)
    token: string;
}

export class PublicLinkDto {
    @ApiProperty()
    @IsBoolean()
    enabled: boolean;

    @ApiPropertyOptional({ description: 'true genera un código nuevo e invalida el enlace anterior' })
    @IsOptional()
    @IsBoolean()
    regenerate?: boolean;
}
