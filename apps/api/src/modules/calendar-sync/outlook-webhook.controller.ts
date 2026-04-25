import {
  Body,
  Controller,
  Header,
  HttpCode,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { Public } from '../auth/public.decorator';
import { RoomMailboxService } from './room-mailbox.service';

/**
 * Microsoft Graph push notifications endpoint.
 *
 * IMPORTANT: When this controller is wired into app.module.ts, the
 * `webhooks/outlook` path must also be added to the TenantMiddleware's
 * `exclude` list (see app.module.ts) — Graph notifications arrive
 * unauthenticated and from arbitrary subdomains, so tenant resolution
 * happens later (subscription_id → space → tenant_id) inside
 * RoomMailboxService.
 */
@Controller('webhooks')
@Public()
export class OutlookWebhookController {
  constructor(
    private readonly roomMailbox: RoomMailboxService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Graph subscription validation handshake. The first request after a
   * `POST /subscriptions` carries `?validationToken=…` in the query string
   * and expects the same value echoed back as `text/plain` within 10 seconds.
   *
   * If `validationToken` is absent we treat the body as a notification batch.
   */
  @Post('outlook')
  @HttpCode(202)
  @Header('Content-Type', 'text/plain')
  async receive(
    @Query() query: Record<string, unknown>,
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const validation = this.roomMailbox.validationToken(query);
    if (validation) {
      res.status(200).type('text/plain').send(validation);
      return;
    }
    // Notification batch: respond 202 fast, process in the background.
    // Graph re-delivers if we don't 2xx within ~30s, so we await synchronously
    // here for v1 (the work is bounded). When traffic warrants, push to a
    // background queue and return immediately.
    const expectedClientState =
      this.config.get<string>('MICROSOFT_GRAPH_WEBHOOK_CLIENT_STATE') ?? null;

    await this.roomMailbox.handleNotifications(
      body as { value: never[] },
      expectedClientState,
    );
    res.status(202).type('text/plain').send('');
  }
}
