import { Body, Controller, Headers, Ip, Post } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { WebhookIngestService } from './webhook-ingest.service';

@Controller('webhooks')
@Public()
export class WebhookIngestController {
  constructor(private readonly svc: WebhookIngestService) {}

  @Post('ingest')
  ingest(
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Ip() ip: string,
  ) {
    const authorization = firstHeader(headers, 'authorization');
    const externalSystem = firstHeader(headers, 'x-prequest-external-system') ?? null;
    const externalId = firstHeader(headers, 'x-prequest-external-id') ?? null;
    return this.svc.ingest(body ?? {}, {
      authorization,
      sourceIp: ip,
      externalSystem,
      externalId,
      rawHeaders: {
        'user-agent': firstHeader(headers, 'user-agent'),
        'content-type': firstHeader(headers, 'content-type'),
        'x-prequest-external-system': externalSystem,
        'x-prequest-external-id': externalId,
      },
    });
  }
}

function firstHeader(
  headers: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = headers[key.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}
