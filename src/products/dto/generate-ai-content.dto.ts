import { IsString, IsNotEmpty, IsArray, IsOptional } from 'class-validator';

export class GenerateAIContentDto {
    @IsString()
    @IsNotEmpty()
    productId: string;

    @IsArray()
    @IsOptional()
    targetMarketplaces?: string[];

    @IsString()
    @IsOptional()
    tone?: 'professional' | 'casual' | 'persuasive';
}