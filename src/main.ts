import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupSwagger } from './config/swagger.config';
import { ValidationPipe } from '@nestjs/common';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import * as dns from "dns";

dns.setDefaultResultOrder('ipv4first');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const frontendURLs = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',') : ['*'];
  app.enableCors({
    origin: frontendURLs,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  app.setGlobalPrefix('api/v1'); // Establece un prefijo global para todas las rutas

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true, // Elimina propiedades no definidas en los DTOs
    forbidNonWhitelisted: true, // Lanza error si se envían propiedades no permitidas
    transform: true, // Transforma los payloads a las instancias de los DTOs
  }));

  app.useGlobalInterceptors(new TransformInterceptor());

  setupSwagger(app);

  await app.listen(process.env.PORT ?? 3001, '0.0.0.0');
}
bootstrap();
