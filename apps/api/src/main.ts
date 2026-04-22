import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT') ?? config.get<number>('API_PORT', 3001);
  const host = config.get<string>('API_HOST', '0.0.0.0');

  const corsOrigin = config.get<string>('CORS_ORIGIN', 'http://localhost:5173');
  app.enableCors({
    origin: corsOrigin.split(',').map((o) => o.trim()).filter(Boolean),
    credentials: true,
  });

  app.setGlobalPrefix('api');

  await app.listen(port, host);
  console.log(`Prequest API running on http://${host}:${port}`);
}

bootstrap();
