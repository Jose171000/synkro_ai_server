import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import {AuthService} from './auth.service';
import { LoginDto} from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RolesGuard } from 'src/common/guards/roles.guard';
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
    
    @Post('logout')
    @UseGuards(JwtAuthGuard, RolesGuard)
    logout() {
        
        return { message: 'Sesión cerrada' };
    }
    
}