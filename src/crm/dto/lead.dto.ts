import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
    IsDateString,
    IsEmail,
    IsIn,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    IsUrl,
    Min,
} from 'class-validator';
import { LEAD_STAGES } from '../entities/lead.entity';

export class CreateLeadDto {
    @ApiProperty({ example: 'Ana Torres' })
    @IsString()
    @IsNotEmpty()
    name: string;

    @ApiPropertyOptional({ example: 'Rivesi SAC' })
    @IsOptional()
    @IsString()
    company?: string;

    @ApiPropertyOptional({ example: 'ana@rivesi.com' })
    @IsOptional()
    @IsEmail({}, { message: 'El correo no tiene un formato válido' })
    email?: string;

    @ApiPropertyOptional({ example: '+51 999 999 999' })
    @IsOptional()
    @IsString()
    phone?: string;

    @ApiPropertyOptional({ example: 'instagram' })
    @IsOptional()
    @IsString()
    source?: string;

    @ApiPropertyOptional({ enum: LEAD_STAGES, default: 'nuevo' })
    @IsOptional()
    @IsIn(LEAD_STAGES as unknown as string[])
    stage?: string;

    @ApiPropertyOptional({ example: 2500 })
    @IsOptional()
    @IsNumber()
    @Min(0)
    estimatedValue?: number;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    notes?: string;

    @ApiPropertyOptional({ example: '2026-08-12' })
    @IsOptional()
    @IsDateString()
    lastContactAt?: string;
}

export class UpdateLeadDto extends PartialType(CreateLeadDto) { }

export class ImportLeadsDto {
    @ApiProperty({
        description: 'URL del Google Sheet publicado como CSV',
        example: 'https://docs.google.com/spreadsheets/d/e/2PACX-.../pub?output=csv',
    })
    @IsUrl({ require_tld: false })
    csvUrl: string;

    @ApiPropertyOptional({
        description: 'Si es true solo analiza y devuelve la vista previa, sin guardar nada',
        default: false,
    })
    @IsOptional()
    dryRun?: boolean;
}
