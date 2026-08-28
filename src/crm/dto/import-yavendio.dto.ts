import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class ImportYavendioDto {
    @ApiPropertyOptional({ description: 'Solo calcula el resultado, sin guardar nada.', default: false })
    @IsOptional()
    @IsBoolean()
    dryRun?: boolean;

    @ApiPropertyOptional({ description: 'Deja fuera las conversaciones que nunca tuvieron un mensaje.', default: false })
    @IsOptional()
    @IsBoolean()
    skipEmpty?: boolean;
}
