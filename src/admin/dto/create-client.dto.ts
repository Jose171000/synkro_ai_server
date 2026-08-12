import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';
import { APP_SECTIONS } from '../../common/app-sections';

export class CreateClientDto {
    @ApiProperty({ example: 'Ana' })
    @IsString()
    @IsNotEmpty()
    name: string;

    @ApiProperty({ example: 'Torres' })
    @IsString()
    @IsNotEmpty()
    lastName: string;

    @ApiProperty({ example: 'ana@cliente.com' })
    @IsEmail()
    email: string;

    @ApiProperty({ example: 'ClaveSegura123', minLength: 8 })
    @IsString()
    @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
    password: string;

    @ApiPropertyOptional({ example: 'Rivesi SAC' })
    @IsOptional()
    @IsString()
    nameCompany?: string;

    @ApiPropertyOptional({ example: '+51 999 999 999' })
    @IsOptional()
    @IsString()
    cellPhone?: string;

    @ApiPropertyOptional({
        description: 'Secciones visibles. Vacío = acceso completo.',
        example: ['dashboard', 'analytics'],
        enum: APP_SECTIONS,
        isArray: true,
    })
    @IsOptional()
    @IsArray()
    @IsIn(APP_SECTIONS as unknown as string[], { each: true })
    allowedSections?: string[];

    @ApiPropertyOptional({ enum: ['agency', 'saas'], default: 'saas' })
    @IsOptional()
    @IsIn(['agency', 'saas'])
    clientType?: 'agency' | 'saas';
}
