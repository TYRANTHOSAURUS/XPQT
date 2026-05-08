import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import compression from 'compression';
import type { Request } from 'express';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';

async function bootstrap() {
  // Disable NestJS's auto bodyParser so we control parser order explicitly.
  // The path-scoped parser for /api/webhooks/mail (rawBody capture) used to
  // displace the framework default, leaving other POSTs with `req.body`
  // unparsed and DTOs as undefined — every POST returned 500. Now we
  // register both parsers ourselves: rawBody-capturing JSON for the mail
  // webhook path, plain JSON globally for everything else.
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  app.use(
    '/api/webhooks/mail',
    json({
      limit: '1mb',
      verify: (req: Request, _res, buf: Buffer) => {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );

  app.use(json({ limit: '1mb' }));

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

  // Phase 7.A.1: normalise every thrown error to the RFC 9457-inspired wire
  // shape. Legacy `throw new BadRequestException('msg')` callers still work;
  // they map to `generic.bad_request`. See docs/superpowers/specs/
  // 2026-05-02-error-handling-system-design.md §3.2.
  app.useGlobalFilters(new AllExceptionsFilter());

  await app.listen(port, host);
  console.log(`Prequest API running on http://${host}:${port}`);
}

bootstrap();
