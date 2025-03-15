import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserService } from '../users/user.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class AuthService {
  constructor(
    private userService: UserService,
    private jwtService: JwtService,
  ) {}

  async register(registerDto: RegisterDto) {
    const user = await this.userService.createUser(registerDto.id ,registerDto.email, registerDto.password, registerDto.name, registerDto.lastName, registerDto.nameCompany, registerDto.cellPhone, registerDto.country, registerDto.url, registerDto.role);
    return { message: 'Usuario creado correctamente', user };
  }

  async login(loginDto: LoginDto) {
    const user = await this.userService.findByEmail(loginDto.email);
    if (!user || !(await bcrypt.compare(loginDto.password, user.password))) {
      throw new UnauthorizedException('Credenciales incorrectas');
    }
    const token = this.jwtService.sign({ id: user.id, email: user.email }, { expiresIn: '1h' });
    return { accessToken: token };
  }
}
