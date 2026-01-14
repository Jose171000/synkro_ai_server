import { Controller, Post, Body, UseGuards, Get, Req } from '@nestjs/common';
import {AuthService} from './auth.service';
import { LoginDto} from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';

@Controller('auth')
export class AuthController {
    constructor(private authService: AuthService) {}

    @Post('register')
    register(@Body() registerDto: RegisterDto) {
        return this.authService.register(registerDto);
    }

    @Post('login')
    login(@Body() LoginDto: LoginDto) {
        return this.authService.login(LoginDto);
    }
    
    @Post('refresh')
    refreshTokens(@Body() refreshTokenDto: RefreshTokenDto) {
        return this.authService.refreshTokens(refreshTokenDto.refreshToken);
    }

    @Post('logout')
    @UseGuards(JwtAuthGuard)
    logout(@Req() req) {
        return this.authService.logout(req.user.sub);
    }

    @Post('forgot-password')
    forgotPassword(@Body() forgotPasswordDto: ForgotPasswordDto) {
        return this.authService.forgotPassword(forgotPasswordDto.email);
    }

    @Post('reset-password')
    resetPassword(@Body() resetPasswordDto: ResetPasswordDto) {
        return this.authService.resetPassword(
            resetPasswordDto.token,
            resetPasswordDto.newPassword,
        );
    }

    @Get('me')
    @UseGuards(JwtAuthGuard)
    getProfile(@Req() req) {
        return req.user;
    }   
}