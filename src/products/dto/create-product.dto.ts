import { IsString, IsNotEmpty, IsOptional, IsNumber, IsArray } from 'class-validator';

export class CreateProductDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    /** Opcional: sin SKU, el sistema genera uno siguiendo el formato de la tienda. */
    @IsString()
    @IsOptional()
    sku?: string;

    @IsString()
    @IsNotEmpty()
    description: string;

    @IsString()
    @IsOptional()
    category?: string;

    @IsString()
    @IsOptional()
    subCategory?: string;

    @IsNumber()
    @IsOptional()
    price?: number;

    @IsNumber()
    @IsOptional()
    stock?: number;

    @IsNumber()
    @IsOptional()
    salePrice?: number | null;

    @IsString()
    @IsOptional()
    saleStartDate?: string | null;

    @IsString()
    @IsOptional()
    saleEndDate?: string | null;

    @IsArray()
    @IsOptional()
    images?: string[];

    @IsArray()
    @IsOptional()
    targetMarketplaces?: string[];
}