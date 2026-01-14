import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService) {
    const secretOrKey = configService.get<string>('JWT_SECRET');
    if (!secretOrKey) {
      throw new Error('JWT_SECRET no fue encontrado en el archivo .env o no fue definido in la configuración');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey,
    });
  }

  async validate(payload: any) {
    // Transformamos 'sub' a 'id' para que sea más fácil de usar en el resto de la app
    return {
      id: payload.sub,
      email: payload.email,
      role: payload.role // ¡No olvides el rol si lo usas para permisos!
    };
  }
}
