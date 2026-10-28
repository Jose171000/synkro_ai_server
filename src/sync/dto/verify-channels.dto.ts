import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, MaxLength } from 'class-validator';

export class VerifyChannelsDto {
    @ApiProperty({ description: 'SKU de la tienda que se quieren comprobar en los canales.', type: [String] })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(100)
    @IsString({ each: true })
    @MaxLength(100, { each: true })
    skus: string[];
}
