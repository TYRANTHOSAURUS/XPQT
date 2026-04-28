import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  type MailAttachment,
  type MailMessage,
  type MailProvider,
  type MailSendResult,
  type MailWebhookEvent,
  type VerifyWebhookArgs,
} from './mail-provider';

/**
 * Postmark adapter for the platform mail-delivery substrate.
 *
 * Why Postmark:
 *   - EU region (Postmark Hetzner DC) for GDPR data residency.
 *   - Native attachment support via the same /email API call (no
 *     two-step "upload then send"). Daily-list PDFs ship as Base64
 *     attachments alongside the body.
 *   - Idempotency via the X-PM-Idempotency-Key header — provider
 *     dedupes identical (key + content) sends within 24h, returning
 *     the cached MessageID without dispatching twice.
 *   - Webhook signature header (`X-Postmark-Signature`, HMAC-SHA256
 *     over the raw body with the configured secret) for verifying
 *     bounce/delivery events end-to-end.
 *
 * Env config:
 *   POSTMARK_SERVER_TOKEN          — required. Server-API token.
 *   POSTMARK_DEFAULT_FROM_EMAIL    — required. e.g. 'noreply@prequest.io'.
 *   POSTMARK_DEFAULT_FROM_NAME     — optional, defaults to 'Prequest'.
 *   POSTMARK_WEBHOOK_SECRET        — required for verifyWebhook(). The
 *                                    shared secret you configured on
 *                                    the Postmark webhook UI.
 *   POSTMARK_TRANSACTIONAL_STREAM  — defaults to 'outbound'.
 *   POSTMARK_BROADCAST_STREAM      — defaults to 'broadcast'.
 *
 * Wiring: `vendor-portal.module.ts` and `daily-list.module.ts` both
 * inject MAIL_PROVIDER; the provider is selected at boot by the env
 * presence of POSTMARK_SERVER_TOKEN — when missing, the
 * LoggingMailProvider stays bound (dev / unconfigured tenants).
 */
@Injectable()
export class PostmarkMailProvider implements MailProvider {
  private readonly serverToken      = process.env.POSTMARK_SERVER_TOKEN ?? '';
  private readonly defaultFromEmail = process.env.POSTMARK_DEFAULT_FROM_EMAIL ?? '';
  private readonly defaultFromName  = process.env.POSTMARK_DEFAULT_FROM_NAME ?? 'Prequest';
  private readonly webhookSecret    = process.env.POSTMARK_WEBHOOK_SECRET ?? '';
  private readonly transactionalStream = process.env.POSTMARK_TRANSACTIONAL_STREAM ?? 'outbound';
  private readonly broadcastStream     = process.env.POSTMARK_BROADCAST_STREAM     ?? 'broadcast';

  /** The Postmark EU API endpoint. Same shape as the US endpoint. */
  private static readonly ENDPOINT = 'https://api.postmarkapp.com/email';

  async send(message: MailMessage): Promise<MailSendResult> {
    if (!this.serverToken) {
      throw new BadRequestException(
        'POSTMARK_SERVER_TOKEN not configured — cannot dispatch mail.',
      );
    }
    if (!this.defaultFromEmail) {
      throw new BadRequestException(
        'POSTMARK_DEFAULT_FROM_EMAIL not configured — cannot dispatch mail.',
      );
    }

    const fromHeader = message.fromName
      ? `"${escapeQuoted(message.fromName)}" <${message.from || this.defaultFromEmail}>`
      : `"${escapeQuoted(this.defaultFromName)}" <${message.from || this.defaultFromEmail}>`;
    const toHeader = message.toName
      ? `"${escapeQuoted(message.toName)}" <${message.to}>`
      : message.to;

    const stream = message.messageStream === 'broadcast'
      ? this.broadcastStream
      : this.transactionalStream;

    const payload: Record<string, unknown> = {
      From:          fromHeader,
      To:            toHeader,
      Subject:       message.subject,
      TextBody:      message.textBody,
      MessageStream: stream,
      /* Tag is a single string in Postmark; flatten the tag map into
         the most-significant value (entity type) for filtering, and
         also send all tags via Metadata for richer webhook payloads. */
      Tag:      message.tags?.entity_type ?? message.tags?.category ?? undefined,
      Metadata: message.tags ?? undefined,
    };
    if (message.htmlBody) payload.HtmlBody = message.htmlBody;
    if (message.replyTo)  payload.ReplyTo  = message.replyTo;
    if (message.attachments?.length) {
      payload.Attachments = message.attachments.map(serializeAttachment);
    }

    const headers: Record<string, string> = {
      'Accept':                  'application/json',
      'Content-Type':            'application/json',
      'X-Postmark-Server-Token': this.serverToken,
    };
    /* X-PM-Idempotency-Key — Postmark dedupes within 24h on this key.
       Stable per (daily_list_id, version) for natural retries; force
       resends append a nonce so admins can override the cache. */
    if (message.idempotencyKey) {
      headers['X-PM-Idempotency-Key'] = message.idempotencyKey;
    }

    let res: Response;
    try {
      res = await fetch(PostmarkMailProvider.ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Postmark request failed: ${msg}`);
    }

    /* 200 = accepted, 422 = validation, 429 = rate-limited, 500+ = retryable.
       The DailyListService.send catch-all wraps anything thrown here as
       a send failure and rolls the CAS state back to 'failed' — that's
       the correct behaviour for retry. */
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new BadRequestException(`Postmark returned non-JSON (${res.status})`);
    }
    if (!res.ok) {
      const errorCode = (body as { ErrorCode?: number })?.ErrorCode;
      const message_  = (body as { Message?: string })?.Message ?? `Postmark ${res.status}`;
      throw new BadRequestException(`Postmark ${res.status} (code=${errorCode}): ${message_}`);
    }
    const ok = body as { MessageID: string; SubmittedAt: string };
    return {
      messageId:  ok.MessageID,
      acceptedAt: ok.SubmittedAt,
    };
  }

  /**
   * Verify the Postmark webhook signature header against the raw body.
   *
   * Postmark sends `X-Postmark-Signature: <base64 hmac-sha256>` where
   * the HMAC is computed over the raw POST body using the per-webhook
   * shared secret. Constant-time compare.
   *
   * Throws UnauthorizedException on mismatch / missing header /
   * unconfigured secret. Returns the parsed event(s) on success.
   */
  verifyWebhook(args: VerifyWebhookArgs): MailWebhookEvent[] {
    if (!this.webhookSecret) {
      throw new UnauthorizedException('POSTMARK_WEBHOOK_SECRET not configured');
    }
    const sigHeader =
      args.headers['x-postmark-signature']
      ?? args.headers['X-Postmark-Signature' as unknown as keyof typeof args.headers];
    if (!sigHeader) {
      throw new UnauthorizedException('missing X-Postmark-Signature header');
    }
    const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    const raw = typeof args.rawBody === 'string'
      ? Buffer.from(args.rawBody, 'utf8')
      : args.rawBody;

    const hmac = createHmac('sha256', this.webhookSecret).update(raw).digest('base64');
    /* timingSafeEqual requires equal-length buffers — short-circuit
       when the header length is unexpected so we return a clean 401
       instead of throwing a length mismatch. */
    if (sig.length !== hmac.length) {
      throw new UnauthorizedException('invalid Postmark signature');
    }
    const ok = timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(hmac, 'utf8'));
    if (!ok) {
      throw new UnauthorizedException('invalid Postmark signature');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new BadRequestException('webhook body is not valid JSON');
    }

    /* Postmark sends one event per POST OR an array (for batch hooks).
       Normalize to an array of MailWebhookEvent. */
    const events = Array.isArray(parsed) ? parsed : [parsed];
    return events
      .map((e) => this.translatePostmarkEvent(e))
      .filter((e): e is MailWebhookEvent => e !== null);
  }

  private translatePostmarkEvent(e: unknown): MailWebhookEvent | null {
    const ev = e as Record<string, unknown>;
    const recordType = String(ev.RecordType ?? '');
    const messageID  = String(ev.MessageID  ?? '');
    const recipient  = String(ev.Recipient ?? ev.Email ?? '');
    const at = String(ev.DeliveredAt ?? ev.BouncedAt ?? ev.ReceivedAt ?? new Date().toISOString());

    switch (recordType) {
      case 'Delivery':
        return { type: 'delivered',  providerMessageId: messageID, recipient, at, raw: ev };
      case 'Bounce':
        return {
          type: 'bounced',
          providerMessageId: messageID,
          recipient,
          at,
          reason:     String(ev.Description ?? ev.Details ?? 'bounce'),
          bounceType: mapPostmarkBounceType(String(ev.Type ?? '')),
          raw: ev,
        };
      case 'SpamComplaint':
        return { type: 'complained', providerMessageId: messageID, recipient, at, raw: ev };
      case 'SubscriptionChange':
      case 'Open':
      case 'Click':
        /* Engagement signals — not part of the v1 state machine.
           Sprint 5 wires open-tracking; for now we drop them. */
        return null;
      default:
        return {
          type: 'failed',
          providerMessageId: messageID,
          recipient,
          at,
          reason: `unknown record type: ${recordType}`,
          raw: ev,
        };
    }
  }
}

function serializeAttachment(att: MailAttachment): Record<string, unknown> {
  /* Postmark wants Content as base64 of the file bytes + Name + ContentType.
     ContentID is set when the attachment should be inline (rendered via
     `cid:<id>` in the HTML body). */
  const out: Record<string, unknown> = {
    Name:        att.filename,
    Content:     att.contents.toString('base64'),
    ContentType: att.contentType,
  };
  if (att.inlineCid) out.ContentID = `cid:${att.inlineCid}`;
  return out;
}

function escapeQuoted(s: string): string {
  /* Postmark's From/To "Display Name" <email> shape requires escaping
     literal quotes in the display name. Conservative — strip CR/LF too
     so we can't be header-injected. */
  return s.replace(/[\r\n"]/g, ' ');
}

/**
 * Postmark Bounce types (https://postmarkapp.com/developer/api/bounce-api):
 *   HardBounce / SpamNotification → permanent ('hard')
 *   Transient / SoftBounce / ChallengeVerification → retryable ('soft')
 *   Blocked / SpamComplaint → block-listed ('block')
 *   anything else → 'unknown'
 */
function mapPostmarkBounceType(t: string): 'hard' | 'soft' | 'block' | 'unknown' {
  if (t === 'HardBounce' || t === 'BadEmailAddress' || t === 'SpamNotification') return 'hard';
  if (t === 'Transient' || t === 'SoftBounce' || t === 'ChallengeVerification' || t === 'AutoResponder') return 'soft';
  if (t === 'Blocked' || t === 'SpamComplaint' || t === 'ManuallyDeactivated') return 'block';
  return 'unknown';
}
