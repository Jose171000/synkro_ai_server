import { IsIn, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ExportQueryDto } from './export-query.dto';
import { CANALES_DE_FICHA, CanalDeFicha } from '../fichas-por-canal.service';

export class FichasQueryDto extends ExportQueryDto {
    @ApiPropertyOptional({ description: 'Un solo canal; sin él salen todos', enum: CANALES_DE_FICHA })
    @IsOptional()
    @IsIn(CANALES_DE_FICHA)
    canal?: CanalDeFicha;
}
