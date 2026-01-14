import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength, IsIn } from 'class-validator';
import { UserRole } from '../user-role'; // Importar el enum

export class CreateUserDto {
    @IsEmail()
    @IsNotEmpty()
    email: string;

    @IsString()
    @MinLength(8)
    password: string;

    @IsString()
    @IsNotEmpty()
    name: string;

    @IsString()
    @IsOptional()
    lastName?: string;

    @IsString()
    @IsOptional()
    nameCompany?: string;

    @IsString()
    @IsOptional()
    cellPhone?: string;

    @IsString()
    @IsOptional()
    country?: string;

    @IsString()
    @IsOptional()
    url?: string;

    @IsIn(Object.values(UserRole))
    @IsOptional()
    role?: string;
}
