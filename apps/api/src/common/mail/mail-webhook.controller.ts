import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../modules/auth/public.decorator';
import { DbService } from '../db/db.service';
import {
  MAIL_PROVIDER,
  type MailProvider,
  type MailWebhookEvent,
} from './mail-provider';

/**
 * Receives signed webhook callbacks from the configured mail provider
 * (Resend today; future SES / Postmark route here too via the
 * MailProvider abstraction).
 *
 * Auth: the provider's signature header. Bearer auth + tenant
 * middleware are skipped — the provider has no tenant context to send.
 * The provider is wired to send to a single tenant-less endpoint;
 * correlation happens via the platform-owned `daily_list_id` tag
 * (preferred; race-free) or by provider message id (fallback).
 *
 * Endpoint MUST be exempted from the global TenantMiddleware. See
 * `apps/api/src/common/middleware/tenant.middleware.ts` exclude list.
 *
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-b-design.md §11.
 */
@Public()
@Controller('webhooks/mail')
export class MailWebhookController {
  private readonly log = new Logger(MailWebhookController.name);

  constructor(
    @Inject(MAIL_PROVIDER) private readonly provider: MailProvider,
    private readonly db: DbService,
  ) {}

  /**
   * POST /webhooks/mail
   *
   * Body: provider-native JSON (Postmark Delivery / Bounce / etc).
   * Headers: provider-native signature header.
   *
   * Returns 200 even on no-op events (provider retries on non-2xx so
   * the receiver MUST be idempotent + return 2xx for any signed event).
   */
  @Post()
  @HttpCode(200)
  async handle(
    @Req() req: Request,
    @Headers() headers: Record<string, string>,
    @Body() _body: unknown,
  ) {
    /* Verify against the raw body bytes. Express's bodyParser has
       already parsed `_body`, but we attach the raw buffer in main.ts
       via verify + rawBody hook; pull it from req. */
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!raw) {
      throw new BadRequestException(
        'rawBody not captured — register the bodyParser verify hook in main.ts',
      );
    }

    let events: MailWebhookEvent[];
    try {
      events = this.provider.verifyWebhook({ rawBody: raw, headers });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`mail webhook signature/verify rejected: ${msg}`);
      throw err;
    }

    if (events.length === 0) return { ok: true, processed: 0 };

    let processed = 0;
    for (const event of events) {
      try {
        await this.ingest(event);
        processed += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(
          `mail webhook ingest failed for msg=${event.providerMessageId}: ${msg}`,
        );
        /* Don't bubble — Postmark retries on non-2xx, but a malformed
           single event in a batch shouldn't replay the whole batch.
           The raw row is still in email_delivery_events; ops can replay. */
      }
    }
    return { ok: true, processed };
  }

  /**
   * One event → one email_delivery_events row + downstream state update.
   * Correlation: look up the message id in vendor_daily_lists first
   * (most volume); fall back to vendor magic-link sends.
   */
  private async ingest(event: MailWebhookEvent): Promise<void> {
    /* Correlate first — we need the tenant_id to write the audit row + to
       update the right entity. */
    const correlated = await this.correlate(event);

    /* Persist the raw event regardless — even un-correlated events stay
       in the table so ops can reprocess after fixing the correlation. */
    await this.db.query(
      `insert into public.email_delivery_events
         (tenant_id, provider_message_id, correlated_entity_type,
          correlated_entity_id, event_type, bounce_type, recipient_email,
          reason, occurred_at, raw_payload)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::jsonb)`,
      [
        correlated?.tenantId ?? null,
        event.providerMessageId,
        correlated?.entityType ?? 'unknown',
        correlated?.entityId ?? null,
        event.type,
        event.type === 'bounced' ? event.bounceType : null,
        event.recipient,
        event.type === 'bounced' || event.type === 'failed' ? event.reason : null,
        event.at,
        JSON.stringify(event.raw),
      ],
    );

    /* Drive the downstream state machine. We update vendor_daily_lists
       in-line because the state transitions are simple (sent →
       delivered / bounced / failed). Vendor magic-link sends are
       informational only — we record the event but don't change row
       state today (Sprint 5 may add a "last delivery status" field). */
    if (correlated?.entityType === 'vendor_daily_list') {
      await this.updateDailyListStatus(correlated.entityId, correlated.tenantId, event);
    }
  }

  /**
   * Correlate a webhook event to its originating row.
   *
   * Codex round-1 fix: round-0 only correlated by
   * vendor_daily_lists.email_message_id, but that column is set in the
   * post-send tx UPDATE. If the provider posts a delivery callback
   * BEFORE the send-tx commits (Resend has dispatched faster than
   * Postgres on local benchmarks), correlation lost the row and the
   * email_status state machine stayed at 'sent'.
   *
   * Two-layer correlation:
   *   1. Tags-first: every send tags `daily_list_id` (we own the value),
   *      so the row id is in the webhook payload regardless of
   *      message_id timing.
   *   2. Message-id fallback: for legacy events from before tagging
   *      was added, AND for vendor magic-link sends (Sprint 5).
   */
  private async correlate(event: MailWebhookEvent): Promise<CorrelatedEntity | null> {
    const tags = extractTags(event.raw);
    const tagDailyListId = tags?.daily_list_id;
    if (tagDailyListId) {
      const dl = await this.db.queryOne<{ id: string; tenant_id: string }>(
        `select id, tenant_id from public.vendor_daily_lists
          where id = $1
          limit 1`,
        [tagDailyListId],
      );
      if (dl) {
        return { tenantId: dl.tenant_id, entityType: 'vendor_daily_list', entityId: dl.id };
      }
    }
    /* Fallback: provider message id. Used when tags are missing or
       when the row id is yet to flow into the email tag pipeline. */
    const dl = await this.db.queryOne<{ id: string; tenant_id: string }>(
      `select id, tenant_id from public.vendor_daily_lists
        where email_message_id = $1
        limit 1`,
      [event.providerMessageId],
    );
    if (dl) {
      return { tenantId: dl.tenant_id, entityType: 'vendor_daily_list', entityId: dl.id };
    }
    return null;
  }

  private async updateDailyListStatus(
    daglijstId: string,
    tenantId: string,
    event: MailWebhookEvent,
  ): Promise<void> {
    /* Map provider events to the email_status check-constraint values
       (defined in 00168 + extended in 00175). */
    let nextStatus: string | null = null;
    if (event.type === 'delivered')  nextStatus = 'delivered';
    if (event.type === 'bounced')    nextStatus = 'bounced';
    if (event.type === 'failed')     nextStatus = 'failed';
    if (event.type === 'complained') nextStatus = 'bounced';      // collapse for v1; spam=bounce-equivalent
    if (!nextStatus) return;

    /* Only UPDATE when the row hasn't already been moved past 'sent'.
       Provider events arrive in order most of the time but networks
       deliver out-of-order — clamp 'delivered' so a late 'bounced'
       doesn't overwrite an earlier 'delivered'. */
    await this.db.query(
      `update public.vendor_daily_lists
          set email_status = case
                when email_status in ('delivered','bounced') then email_status
                else $3
              end,
              email_error  = case when $3 in ('bounced','failed') then $4 else email_error end
        where tenant_id = $1 and id = $2`,
      [
        tenantId,
        daglijstId,
        nextStatus,
        event.type === 'bounced' || event.type === 'failed' ? event.reason : null,
      ],
    );
  }
}

interface CorrelatedEntity {
  tenantId: string;
  entityType: 'vendor_daily_list';
  entityId: string;
}

/**
 * Pull our platform tags out of a provider-native event payload.
 *
 * Resend echoes tags back in the webhook payload at `data.tags` as an
 * array of `{name, value}` pairs. Future providers (SES) inline tags
 * differently — this helper normalises by walking `data.tags` and
 * `data.headers['X-Tag']`, returning a flat string-string map.
 *
 * The codex round-1 fix correlates by `daily_list_id` from this map
 * to dodge the email_message_id timing race.
 */
function extractTags(rawEvent: unknown): Record<string, string> | null {
  if (!rawEvent || typeof rawEvent !== 'object') return null;
  const ev = rawEvent as Record<string, unknown>;
  const data = (ev.data as Record<string, unknown> | undefined) ?? {};
  const tags = data.tags;
  if (!Array.isArray(tags)) return null;
  const out: Record<string, string> = {};
  for (const t of tags) {
    if (t && typeof t === 'object' && 'name' in t && 'value' in t) {
      const tt = t as { name: unknown; value: unknown };
      if (typeof tt.name === 'string' && tt.value != null) {
        out[tt.name] = String(tt.value);
      }
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}
