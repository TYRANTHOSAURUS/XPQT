import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import compression from 'compression';
import type { Request } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  /* Mail-webhook signature verification needs the raw request body
     bytes (provider HMACs the bytes the client received; JSON parse
     mutates whitespace). Capture it on the json bodyParser's verify
     hook so MailWebhookController can read req.rawBody. Scoped to the
     mail webhook path so we don't bloat the global request memory
     footprint on every JSON request. */
  app.use(
    '/api/webhooks/mail',
    json({
      limit: '1mb',
      verify: (req: Request, _res, buf: Buffer) => {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT') ?? config.get<number>('API_PORT', 3001);
  const host = config.get<string>('API_HOST', '0.0.0.0');

  const corsOrigin = config.get<string>('CORS_ORIGIN', 'http://localhost:5173');
  app.enableCors({
    origin: corsOrigin.split(',').map((o) => o.trim()).filter(Boolean),
    credentials: true,
    // Browsers send `If-None-Match` automatically on revalidation; the
    // CORS preflight has to whitelist our `ETag` response header so the
    // SPA can read it from `cache: 'no-cache'` requests.
    exposedHeaders: ['ETag'],
  });

  // Gzip / deflate every JSON payload above 1 KB. The desk scheduler
  // returns ~50–150 KB of room + reservation rows on a busy week view;
  // gzip cuts that ~5×, eliminating most of the wire-time on a typical
  // refetch. Cheap on the CPU side (sub-ms for our sizes).
  app.use(compression({ threshold: 1024 }));

  app.setGlobalPrefix('api');

  await app.listen(port, host);
  console.log(`Prequest API running on http://${host}:${port}`);
}

bootstrap();
