import { Controller, Post, Body, UseGuards, Get, Req, Patch } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiBody } from '@nestjs/swagger';
import { ApiStandardResponse } from 'src/common/decorators/api-standard-response.decorator';
import { AuthResponseDto, TokenResponseDto, UserResponseDto } from './dto/auth-response.dto';
import { MessageResponseDto } from './dto/message-response.dto';
import { MailService } from 'src/mail/mail.service';
import { SendTestEmailDto } from './dto/send-test-email.dto';

@ApiTags('auth')
@ApiBearerAuth()
@Controller('auth')
export class AuthController {
    constructor(
        private authService: AuthService,
        private mailService: MailService,
    ) { }

    // Endpoint sensible: 5 intentos por minuto y 20 por hora desde una IP
    @Throttle({ short: { limit: 5, ttl: 60_000 }, medium: { limit: 20, ttl: 3_600_000 } })
    @Post('register')
    @ApiOperation({ summary: 'Register a new user' })
    @ApiStandardResponse(AuthResponseDto)
    register(@Body() registerDto: RegisterDto) {
        return this.authService.register(registerDto);
    }

    // Endpoint sensible: 5 intentos por minuto y 20 por hora desde una IP
    @Throttle({ short: { limit: 5, ttl: 60_000 }, medium: { limit: 20, ttl: 3_600_000 } })
    @Post('login')
    @ApiOperation({ summary: 'Login and get tokens' })
    @ApiStandardResponse(AuthResponseDto)
    login(@Body() LoginDto: LoginDto) {
        return this.authService.login(LoginDto);
    }

    @Post('refresh')
    @ApiOperation({ summary: 'Refresh access token' })
    @ApiStandardResponse(TokenResponseDto)
    refreshTokens(@Body() refreshTokenDto: RefreshTokenDto) {
        return this.authService.refreshTokens(refreshTokenDto.refreshToken);
    }

    @Post('logout')
    @UseGuards(JwtAuthGuard)
    @ApiOperation({ summary: 'Logout a user' })
    @ApiStandardResponse(MessageResponseDto)
    logout(@Req() req) {
        return this.authService.logout(req.user.sub);
    }

    // Endpoint sensible: 5 intentos por minuto y 20 por hora desde una IP
    @Throttle({ short: { limit: 5, ttl: 60_000 }, medium: { limit: 20, ttl: 3_600_000 } })
    @Post('forgot-password')
    @ApiOperation({ summary: 'Request password reset email' })
    @ApiStandardResponse(MessageResponseDto)
    forgotPassword(@Body() forgotPasswordDto: ForgotPasswordDto) {
        return this.authService.forgotPassword(forgotPasswordDto.email);
    }

    // Endpoint sensible: 5 intentos por minuto y 20 por hora desde una IP
    @Throttle({ short: { limit: 5, ttl: 60_000 }, medium: { limit: 20, ttl: 3_600_000 } })
    @Post('reset-password')
    @ApiOperation({ summary: 'Reset user password' })
    @ApiStandardResponse(MessageResponseDto)
    resetPassword(@Body() resetPasswordDto: ResetPasswordDto) {
        return this.authService.resetPassword(
            resetPasswordDto.token,
            resetPasswordDto.newPassword,
        );
    }

    @Get('profile')
    @UseGuards(JwtAuthGuard)
    @ApiOperation({ summary: 'Get current user profile' })
    @ApiStandardResponse(UserResponseDto)
    getProfile(@Req() req) {
        return this.authService.getProfile(req.user.id);
    }

    @Patch('profile')
    @UseGuards(JwtAuthGuard)
    @ApiOperation({ summary: 'Update name and last name' })
    @ApiStandardResponse(UserResponseDto)
    updateProfile(@Req() req, @Body() updateProfileDto: UpdateProfileDto) {
        return this.authService.updateProfile(req.user.sub, updateProfileDto);
    }

    @Patch('change-password')
    @UseGuards(JwtAuthGuard)
    @ApiOperation({ summary: 'Change current user password' })
    @ApiStandardResponse(MessageResponseDto)
    changePassword(@Req() req, @Body() changePasswordDto: ChangePasswordDto) {
        return this.authService.changePassword(req.user.sub, changePasswordDto);
    }

    // ⚠️ Solo para desarrollo — eliminar antes de producción
    @Post('test-email')
    @UseGuards(JwtAuthGuard)
    @ApiOperation({ summary: '[DEV] Send a test email' })
    @ApiBody({ type: SendTestEmailDto })
    @ApiStandardResponse(MessageResponseDto)
    async sendTestEmail(@Body() dto: SendTestEmailDto) {
        await this.mailService.sendTestEmail(dto.to, dto.name);
        return { message: `Email de prueba enviado a ${dto.to}` };
    }
}