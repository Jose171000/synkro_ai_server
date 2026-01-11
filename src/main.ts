import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: '*', // Cambia esto a la URL de tu frontend en producción
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });
  // app.setGlobalPrefix('api'); // Establece un prefijo global para todas las rutas

  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
