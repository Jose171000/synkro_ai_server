import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class ReviewModeDto {
    @ApiProperty({ description: 'true = los cambios esperan aprobación; false = se envían directo', example: true })
    @IsBoolean()
    enabled: boolean;
}

export class RejectChangeDto {
    @ApiPropertyOptional({ description: 'Motivo del rechazo', example: 'Precio mal tecleado' })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    reason?: string;
}
