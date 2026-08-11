import { IsEmail, IsNotEmpty, IsString, MinLength, IsOptional, IsEnum } from 'class-validator';

export enum UserRole {
    USER = 'user',
    ADMIN = 'admin',
    MODERATOR = 'moderator',
}

export class RegisterDto{
    @IsString()
    @IsNotEmpty()
    name:string;

    @IsString()
    @IsNotEmpty()
    lastName:string;

    @IsEmail()
    @IsNotEmpty()
    email:string;

    @IsString()
    @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres'})
    password:string;

    @IsString()
    @IsOptional()
    nameCompany?: string;

    @IsString()
    @IsOptional()
    cellPhone?:string;

    @IsString()
    @IsOptional()
    country?:string;

    @IsString()
    @IsOptional()
    url?:string;

    // El rol NO se acepta desde el registro público: permitiría que
    // cualquiera se auto-asigne admin. Se asigna por ADMIN_EMAILS o por
    // un administrador existente.
}

