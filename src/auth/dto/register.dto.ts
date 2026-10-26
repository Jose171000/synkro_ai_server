import { IsEmail, IsNotEmpty, IsString, MinLength, MaxLength, IsOptional, IsEnum, Matches, ValidateIf } from 'class-validator';

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

    /**
     * Código de la invitación a una tienda. Quien se registra con uno válido (y con el correo invitado) es parte del
     * equipo de esa tienda: no necesita datos de empresa ni espera aprobación.
     */
    @IsString()
    @IsOptional()
    @MaxLength(200)
    invitationToken?: string;

    /** Nombre de su tienda o negocio. */
    @ValidateIf((o) => !o.invitationToken)
    @IsString()
    @IsNotEmpty({ message: 'Escribe el nombre de tu tienda.' })
    @MaxLength(120)
    nameCompany: string;

    /** RUC de la empresa (11 dígitos). */
    @ValidateIf((o) => !o.invitationToken)
    @IsString()
    @Matches(/^(10|15|16|17|20)\d{9}$/, { message: 'El RUC debe tener 11 dígitos y empezar con 10, 15, 16, 17 o 20.' })
    ruc: string;

    /** Razón social registrada en SUNAT. */
    @ValidateIf((o) => !o.invitationToken)
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

