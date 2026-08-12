import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { APP_SECTIONS } from '../../common/app-sections';

export class ResetClientPasswordDto {
    @ApiPropertyOptional({
        description: 'Contraseña nueva. Si se omite, el sistema genera una y la devuelve.',
        minLength: 8,
    })
    @IsOptional()
    @IsString()
    @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
    newPassword?: string;
}

export class UpdateAccessDto {
    @ApiPropertyOptional({
        description: 'Secciones visibles para el usuario. Vacío = acceso completo.',
        example: ['dashboard', 'analytics'],
        enum: APP_SECTIONS,
        isArray: true,
    })
    @IsOptional()
    @IsArray()
    @IsIn(APP_SECTIONS as unknown as string[], { each: true })
    allowedSections?: string[];

    @ApiPropertyOptional({ description: 'Desactivar la cuenta sin borrarla' })
    @IsOptional()
    @IsBoolean()
    isActive?: boolean;
}
