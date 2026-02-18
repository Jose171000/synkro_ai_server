import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { INestApplication } from '@nestjs/common';

export function setupSwagger(app: INestApplication): void {
  const options = new DocumentBuilder()
    .setTitle('Synkro AI Server')
    .setDescription('API documentation for Synkro AI Server')
    .setVersion('1.0')
    .addBearerAuth() // Permitir autenticación con JWT
    .build();

  const document = SwaggerModule.createDocument(app, options);
  SwaggerModule.setup('api/docs', app, document);
}
