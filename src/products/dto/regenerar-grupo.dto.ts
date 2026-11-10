import { IsArray, IsOptional, IsString } from 'class-validator';

export class RegenerarGrupoDto {
    @IsArray()
    @IsOptional()
    @IsString({ each: true })
    targetMarketplaces?: string[];

    /** Mismo valor que ya manda el diálogo de regenerar (p. ej. «profesional»): se pasa tal cual a la IA. */
    @IsString()
    @IsOptional()
    tone?: string;
}
