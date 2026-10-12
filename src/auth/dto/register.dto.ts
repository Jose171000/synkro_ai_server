import { IsEmail, IsNotEmpty, IsString, MinLength, MaxLength, IsOptional, IsEnum, Matches } from 'class-validator';

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

    /** Nombre de su tienda o negocio. */
    @IsString()
    @IsNotEmpty({ message: 'Escribe el nombre de tu tienda.' })
    @MaxLength(120)
    nameCompany: string;

    /** RUC de la empresa (11 dígitos). */
    @IsString()
    @Matches(/^(10|15|16|17|20)\d{9}$/, { message: 'El RUC debe tener 11 dígitos y empezar con 10, 15, 16, 17 o 20.' })
    ruc: string;

    /** Razón social registrada en SUNAT. */
    @IsString()
    @IsNotEmpty({ message: 'Escribe la razón social de tu empresa.' })
    @MaxLength(200)
    businessName: string;

    @IsString()
    @IsOptional()
    cellPhone?:string;

    @IsString()
    @IsOptional()
    country?:string;

    /** Página web o perfil de venta (opcional). */
    @IsString()
    @IsOptional()
    @MaxLength(300)
    url?:string;

    // El rol NO se acepta desde el registro público: permitiría que
    // cualquiera se auto-asigne admin. Se asigna por ADMIN_EMAILS o por
    // un administrador existente.
}

