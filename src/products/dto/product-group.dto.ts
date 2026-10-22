import { IsArray, IsBoolean, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

/**
 * Los ejes y las variantes se validan a fondo en ProductGroupsService (valores, combinaciones repetidas, SKU, límites):
 * aquí solo se exige la forma general, para que el ValidationPipe global no rechace los objetos anidados.
 */
export class CreateProductGroupDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsString()
    @IsNotEmpty()
    parentSku: string;

    @IsOptional()
    @IsString()
    description?: string;

    @IsOptional()
    @IsString()
    category?: string;

    @IsOptional()
    @IsString()
    subCategory?: string;

    @IsOptional()
    @IsArray()
    targetMarketplaces?: string[];

    @IsOptional()
    @IsBoolean()
    generateWithAi?: boolean;

    @IsArray()
    axes: { name: string; values: string[] }[];

    @IsArray()
    variants: { values: Record<string, string>; sku?: string | null; price?: number | null; stock?: number | null; images?: string[] }[];
}

export class AddVariantsDto {
    @IsOptional()
    @IsArray()
    axes?: { name: string; values: string[] }[];

    @IsOptional()
    @IsObject()
    thisVariant?: Record<string, string>;

    @IsArray()
    variants: { values: Record<string, string>; sku?: string | null; price?: number | null; stock?: number | null; images?: string[] }[];
}
