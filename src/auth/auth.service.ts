import { Injectable, UnauthorizedException, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { UserService } from '../users/user.service';
import { UserRole } from '../users/user-role';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshToken } from './entities/refresh-token.entity';
import { PasswordReset } from './entities/password-reset.entity';
import { ConfigService } from '@nestjs/config';
import { User } from '../users/entities/user.entity';
import { MailService } from '../mail/mail.service';
import { StoresService } from '../stores/stores.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ClientProfile } from '../admin/entities/client-profile.entity';

@Injectable()
export class AuthService {
  constructor(
    private userService: UserService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private mailService: MailService,
    private storesService: StoresService,
    @InjectRepository(RefreshToken)
    private refreshTokenRepository: Repository<RefreshToken>,
    @InjectRepository(PasswordReset)
    private passwordResetRepository: Repository<PasswordReset>,
    @InjectRepository(ClientProfile)
    private profileRepository: Repository<ClientProfile>,
  ) { }

  async register(registerDto: RegisterDto): Promise<
    | { user: User; accessToken: string; refreshToken: string; pending?: undefined }
    | { user: User; pending: true; message: string }
  > {
    const email = registerDto.email.trim().toLowerCase();
    const existingUser = await this.userService.findByEmail(email);
    if (existingUser) {
      throw new ConflictException('El email ya está registrado');
    }

    // Con código de invitación el registro es el de una persona del equipo de una tienda, no el de una empresa nueva.
    let invitacion: Awaited<ReturnType<StoresService['invitacionParaRegistro']>> = null;
    if (registerDto.invitationToken) {
      invitacion = await this.storesService.invitacionParaRegistro(registerDto.invitationToken, email);
      if (!invitacion) {
        throw new BadRequestException('La invitación no es válida, ya caducó o es para otro correo. Pide una nueva al dueño de la tienda.');
      }
    }

    // El rol nunca viene del cliente. Solo los correos declarados en
    // ADMIN_EMAILS nacen como admin; el resto son usuarios normales.
    const adminEmails = (process.env.ADMIN_EMAILS || '')
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);
    const esAdmin = adminEmails.includes(email);
    const role = esAdmin ? UserRole.ADMIN : UserRole.USER;

    // Quien se registra por su cuenta espera la aprobación de un superadmin.
    const user = await this.userService.createUser({
      name: registerDto.name,
      lastName: registerDto.lastName,
      email,
      password: registerDto.password,
      nameCompany: invitacion ? invitacion.store.name : registerDto.nameCompany,
      cellPhone: registerDto.cellPhone,
      country: registerDto.country,
      url: registerDto.url,
      role,
    }, esAdmin || invitacion ? { approvalStatus: 'approved', approvedAt: new Date() } : { approvalStatus: 'pending' });

    // Datos de la empresa: quedan en su perfil comercial para revisarlos al aprobar. Una persona invitada es del equipo
    // de una tienda que ya existe: no es un cliente nuevo y no se le crea perfil de empresa.
    if (!invitacion) await this.profileRepository.save(this.profileRepository.create({
      user: { id: user.id } as any,
      ruc: registerDto.ruc,
      businessName: registerDto.businessName,
      contactName: `${registerDto.name} ${registerDto.lastName}`.trim(),
      contactPhone: registerDto.cellPhone,
      clientType: 'saas',
      status: 'activo',
    })).catch(err => console.error('[AuthService] No se pudo guardar el perfil de la empresa:', err.message));

    // Si su correo tenía una invitación a una tienda la cuenta nace «por invitación» (no puede crear tiendas propias).
    // Saltarse la aprobación manual exige el código de la invitación (arriba); el correo solo no basta.
    // No debe impedir el registro si esta comprobación falla.
    await this.storesService.flagIfInvited(user.id, user.email).catch(err => {
      console.error('[AuthService] No se pudo comprobar la invitación:', err.message);
    });

    // La invitación se acepta aquí mismo: la persona entra ya con la tienda activa.
    let tiendaInvitada: { storeId: string; name: string; role: string } | null = null;
    if (invitacion && registerDto.invitationToken) {
      tiendaInvitada = await this.storesService.acceptInvitation(user.id, registerDto.invitationToken).catch(err => {
        console.error('[AuthService] No se pudo aceptar la invitación al registrarse:', err.message);
        return null;
      });
    }

    if (user.approvalStatus === 'pending') {
      // Aviso interno a los superadmins y acuse al solicitante (sin bloquear el registro si el correo falla).
      const admins = await this.userService.findAdminEmails().catch(() => [] as string[]);
      this.mailService.sendSignupRequestToAdmins(admins, {
        name: `${user.name} ${user.lastName}`.trim(),
        email: user.email,
        storeName: registerDto.nameCompany,
        website: registerDto.url ?? null,
        ruc: registerDto.ruc,
        businessName: registerDto.businessName,
        phone: registerDto.cellPhone ?? null,
      }).catch(err => console.error('[AuthService] No se pudo avisar a los superadmins:', err.message));
      this.mailService.sendSignupReceived(user.email, user.name).catch(err =>
        console.error('[AuthService] No se pudo confirmar la solicitud al usuario:', err.message),
      );
      return {
        user: this.sanitizeUser(user),
        pending: true,
        message: 'Recibimos tu solicitud. Revisaremos tus datos y te avisaremos por correo cuando tu cuenta esté aprobada.',
      };
    }

    const tokens = await this.generateTokens(user);

    // Send welcome email (non-blocking — don't fail registration if email fails)
    this.mailService.sendWelcome(user.email, user.name).catch(err =>
      console.error('[AuthService] Failed to send welcome email:', err.message),
    );

    return {
      user: this.sanitizeUser(user),
      ...tokens,
      ...(tiendaInvitada ? { invitedStore: tiendaInvitada } : {}),
    };
  }

  /** Una cuenta sin aprobar no entra: se explica por qué en vez de dejarla ver una app vacía. */
  private asegurarAprobada(user: User): void {
    if (user.approvalStatus === 'pending') {
      throw new ForbiddenException('Tu cuenta está en revisión. Te avisaremos por correo cuando esté aprobada.');
    }
    if (user.approvalStatus === 'rejected') {
      throw new ForbiddenException(
        user.approvalNote
          ? `Tu solicitud no fue aprobada: ${user.approvalNote}`
          : 'Tu solicitud no fue aprobada. Escríbenos si crees que es un error.',
      );
    }
  }

  /**
   * Perfil real desde la base de datos: el JWT solo lleva id/email/rol,
   * así que sin esto la app no vería los permisos de sección ni los
   * cambios que el administrador acabe de hacer.
   */
  async getProfile(userId: string) {
    const user = await this.userService.findById(userId);
    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('Tu cuenta está desactivada. Contacta al administrador.');
    }
    return this.sanitizeUser(user);
  }

  async login(loginDto: LoginDto) {
    const user = await this.userService.findByEmail(loginDto.email);
    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const isPasswordValid = await bcrypt.compare(loginDto.password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }
    // Solo después de comprobar la contraseña: así no se revela a un extraño si una cuenta existe.
    this.asegurarAprobada(user);
    const tokens = await this.generateTokens(user);

    return {
      user: this.sanitizeUser(user),
      ...tokens
    };
  }

  async refreshTokens(refreshToken: string) {
    const tokenEntity = await this.refreshTokenRepository.findOne({
      where: {
        token: refreshToken,
        isRevoked: false,
        expiresAt: MoreThan(new Date()),
      },
      relations: ['user'],
    });
    if (!tokenEntity) {
      throw new UnauthorizedException('Token de refresco inválido o expirado');
    }

    this.asegurarAprobada(tokenEntity.user);

    // Revocar el token actual
    tokenEntity.isRevoked = true;
    await this.refreshTokenRepository.save(tokenEntity);

    // Generar nuevos tokens
    return this.generateTokens(tokenEntity.user);
  }

  async logout(userId: string) {
    // repository.update({ user: { id } }) no soporta relaciones anidadas en TypeORM
    await this.refreshTokenRepository
      .createQueryBuilder()
      .update(RefreshToken)
      .set({ isRevoked: true })
      .where('userId = :userId', { userId })
      .execute();

    return { message: 'Sesión cerrada exitosamente' };
  }

  async forgotPassword(email: string) {
    const user = await this.userService.findByEmail(email);

    // No revelar si el email existe o no (seguridad)
    if (!user) {
      return { message: 'Si el email existe, se ha enviado un enlace de restablecimiento de contraseña' };
    }

    // Invalidar tokens anteriores
    await this.passwordResetRepository
      .createQueryBuilder()
      .update(PasswordReset)
      .set({ isUsed: true })
      .where('userId = :userId AND isUsed = :isUsed', { userId: user.id, isUsed: false })
      .execute();

    // Crear nuevo token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

    await this.passwordResetRepository.save({
      token,
      expiresAt,
      user,
    });

    // Send password reset email
    // No bloquear la respuesta con el envío: si el proveedor de correo
    // no responde (p. ej. el hosting bloquea SMTP saliente), el usuario
    // se quedaría esperando indefinidamente en la pantalla.
    this.mailService.sendPasswordReset(user.email, token).catch(err =>
      console.error('[AuthService] Failed to send password reset email:', err.message),
    );

    return {
      message: 'Si el email existe, se ha enviado un enlace de restablecimiento de contraseña',
      // Solo para desarrollo — muestra el token si el email falla o no está configurado
      ...(this.configService.get('NODE_ENV') !== 'production' && { resetToken: token }),
    };
  }

  async resetPassword(token: string, newPassword: string) {
    const resetEntity = await this.passwordResetRepository.findOne({
      where: {
        token,
        isUsed: false,
        expiresAt: MoreThan(new Date()),
      },
      relations: ['user'],
    });

    if (!resetEntity) {
      throw new BadRequestException('Token inválido o expirado');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await this.userService.updatePassword(resetEntity.user.id, hashedPassword);

    // Marcar token como usado
    resetEntity.isUsed = true;
    await this.passwordResetRepository.save(resetEntity);

    // Revocar todos los refresh tokens (forzar re-login)
    await this.refreshTokenRepository
      .createQueryBuilder()
      .update(RefreshToken)
      .set({ isRevoked: true })
      .where('userId = :userId', { userId: resetEntity.user.id })
      .execute();

    return { message: 'Contraseña actualizada exitosamente' };
  }

  private async generateTokens(user: any) {
    const payload = { sub: user.id, email: user.email, role: user.role };

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: '15m',
    });

    const refreshToken = crypto.randomBytes(64).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 días

    await this.refreshTokenRepository.save({
      token: refreshToken,
      expiresAt,
      user,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: 900, // 15 minutos en segundos

    };
  }

  private sanitizeUser(user: any) {
    const { password, ...result } = user;
    return result;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.userService.updateProfile(userId, {
      name: dto.name,
      lastName: dto.lastName,
    });
    return this.sanitizeUser(user);
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.userService.findById(userId);
    if (!user) throw new UnauthorizedException('Usuario no encontrado');

    const isValid = await bcrypt.compare(dto.currentPassword, user.password);
    if (!isValid) throw new BadRequestException('La contraseña actual es incorrecta');

    const hashed = await bcrypt.hash(dto.newPassword, 12);
    await this.userService.updatePassword(userId, hashed);

    return { message: 'Contraseña actualizada exitosamente' };
  }
}
