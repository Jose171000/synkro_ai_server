import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';

export class FichaParaColorDto {
    @IsString() @MaxLength(200) sku: string;
    @IsOptional() @IsString() @MaxLength(300) nombre?: string;
    @IsOptional() @IsString() @MaxLength(600) imagen?: string;
}

export class FamiliaParaColorDto {
    @IsString() @MaxLength(120) parentSku: string;

    @IsArray()
    @ArrayMinSize(2)
    @ArrayMaxSize(24)
    @ValidateNested({ each: true })
    @Type(() => FichaParaColorDto)
    fichas: FichaParaColorDto[];
}

export class SugerirColoresDto {
    @ApiProperty({ type: [FamiliaParaColorDto], description: 'Familias sin resolver, con la foto de cada oferta (hasta 8 por llamada).' })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(8)
    @ValidateNested({ each: true })
    @Type(() => FamiliaParaColorDto)
    familias: FamiliaParaColorDto[];
}
