import { Controller, Post, Body } from '@nestjs/common';
import {AuthService} from './auth.service';
import { LoginDto} from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

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
    logout() {
        
        return { message: 'Sesión cerrada' };
    }
    
}