import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupSwagger } from './config/swagger.config';
import { ValidationPipe } from '@nestjs/common';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: '*', // Cambia esto a la URL de tu frontend en producción
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
