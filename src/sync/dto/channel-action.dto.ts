import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class ChannelActionDto {
    @ApiPropertyOptional({ description: 'Publicaciones sobre las que actuar. Sin ella actúa sobre todas las del producto (botón general).', type: [String] })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(50)
    @IsUUID('all', { each: true })
    linkIds?: string[];

    @ApiPropertyOptional({ description: 'Quitar es definitivo en algunos canales: hay que confirmarlo expresamente.' })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;

    @ApiPropertyOptional({ description: 'Solo con todas las variantes: la cuenta del canal donde actuar (sin ella, todas las cuentas).' })
    @IsOptional()
    @IsUUID()
    connectionId?: string;
}
