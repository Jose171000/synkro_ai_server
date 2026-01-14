import { Injectable, UnauthorizedException, BadRequestException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { UserService } from '../users/user.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshToken } from './entities/refresh-token.entity';
import { PasswordReset } from './entities/password-reset.entity';
import { ConfigService } from '@nestjs/config';
import { User } from '../users/entities/user.entity';

@Injectable()
export class AuthService {
  constructor(
    private userService: UserService,
    private jwtService: JwtService,
    private configService: ConfigService,
    @InjectRepository(RefreshToken)
    private refreshTokenRepository: Repository<RefreshToken>,
    @InjectRepository(PasswordReset)
    private passwordResetRepository: Repository<PasswordReset>,
  ) { }

  async register(registerDto: RegisterDto): Promise<{ user: User; accessToken: string; refreshToken: string }> {
    const existingUser = await this.userService.findByEmail(registerDto.email);
    if (existingUser) {
      throw new ConflictException('El email ya está registrado');
    }
    
    const hashedPassword = await bcrypt.hash(registerDto.password, 12);
    
    const user = await this.userService.createUser({
      name: registerDto.name,
      lastName: registerDto.lastName,
      email: registerDto.email,
      password: hashedPassword,
      nameCompany: registerDto.nameCompany,
      cellPhone: registerDto.cellPhone,
      country: registerDto.country,
      url: registerDto.url,
      role: registerDto.role,
    });

    const tokens = await this.generateTokens(user);

    return {
      user: this.sanitizeUser(user),
      ...tokens,
    };
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

    // Revocar el token actual
    tokenEntity.isRevoked = true;
    await this.refreshTokenRepository.save(tokenEntity);

    // Generar nuevos tokens
    return this.generateTokens(tokenEntity.user);
  }

  async logout(userId: string) {
    // Revocar todos los refresh tokens del usuario
    await this.refreshTokenRepository.update(
      { user: { id: userId } },
      { isRevoked: true },
    );

    return { message: 'Sesión cerrada exitosamente' };
  }

  async forgotPassword(email: string) {
    const user = await this.userService.findByEmail(email);

    // No revelar si el email existe o no (seguridad)
    if (!user) {
      return { message: 'Si el email existe, se ha enviado un enlace de restablecimiento de contraseña' };
    }

    // Invalidar tokens anteriores
    await this.passwordResetRepository.update(
      { user: { id: user.id }, isUsed: false },
      { isUsed: true },
    );

    // Crear nuevo token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

    await this.passwordResetRepository.save({
      token,
      expiresAt,
      user,
    });

    // TODO: Enviar email con el token
    // await this.emailService.sendPasswordResetEmail(user.email, token);

    return {
      message: 'Si el email existe, se ha enviado un enlace de restablecimiento de contraseña',
      // Solo para desarrollo, eliminar en producción
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
    await this.refreshTokenRepository.update(
      { user: { id: resetEntity.user.id } },
      { isRevoked: true },
    );

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

}
