import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsOptional } from 'class-validator';
import { APP_SECTIONS } from '../../common/app-sections';

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
