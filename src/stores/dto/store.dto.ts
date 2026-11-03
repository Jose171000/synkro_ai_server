import { BadRequestException } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateStoreDto {
    @ApiProperty({ example: 'Rivesi Home' })
    @IsString()
    @MinLength(2)
    @MaxLength(120)
    name: string;

    /** Solo un superadmin: la cuenta que será dueña de la tienda (un cliente). */
    @ApiPropertyOptional({ description: 'Solo superadmin: cuenta dueña de la tienda' })
    @IsOptional()
    @IsUUID()
    ownerId?: string;
}

export class InviteDto {
    @ApiProperty({ example: 'persona@correo.com' })
    @IsEmail()
    email: string;

    @ApiPropertyOptional({ enum: ['editor', 'viewer'], description: 'Rol de fábrica: editor trabaja el catálogo y publica; viewer solo mira. Manda este o customRoleId, no los dos (ver docs/roles-de-tienda.md)' })
    @IsOptional()
    @IsIn(['editor', 'viewer'])
    role?: 'editor' | 'viewer';

    @ApiPropertyOptional({ description: 'Rol personalizado de la tienda' })
    @IsOptional()
    @IsUUID()
    customRoleId?: string;
}

export class ChangeRoleDto {
    @ApiPropertyOptional({ enum: ['editor', 'viewer'], description: 'Rol de fábrica. Manda este o customRoleId, no los dos' })
    @IsOptional()
    @IsIn(['editor', 'viewer'])
    role?: 'editor' | 'viewer';

    @ApiPropertyOptional({ description: 'Rol personalizado de la tienda' })
    @IsOptional()
    @IsUUID()
    customRoleId?: string;
}

export class CreateRoleDto {
    @ApiProperty({ example: 'Vendedor' })
    @IsString()
    @MinLength(2)
    @MaxLength(40)
    name: string;

    @ApiProperty({ description: 'Claves de permisos (GET /stores/permissions/catalog). Los que otros necesitan se agregan solos', example: ['productos.ver', 'ventas.ver', 'ventas.registrar'] })
    @IsArray()
    @ArrayMaxSize(40)
    @IsString({ each: true })
    permissions: string[];
}

export class UpdateRoleDto {
    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MinLength(2)
    @MaxLength(40)
    name?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(40)
    @IsString({ each: true })
    permissions?: string[];
}

/** De un cuerpo con `role` o `customRoleId` (exactamente uno) saca a qué rol se asigna. */
export function asignacionDe(dto: { role?: 'editor' | 'viewer'; customRoleId?: string }): 'editor' | 'viewer' | { customRoleId: string } {
    if (dto.role && dto.customRoleId) throw new BadRequestException('Elige un rol de fábrica o uno personalizado, no los dos.');
    if (dto.customRoleId) return { customRoleId: dto.customRoleId };
    if (dto.role) return dto.role;
    throw new BadRequestException('Indica el rol.');
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
