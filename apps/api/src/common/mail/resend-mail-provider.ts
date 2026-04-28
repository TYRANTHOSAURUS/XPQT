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
 * Resend adapter for the platform mail-delivery substrate.
 *
 * Why Resend (over Postmark — codex 2026-04-28 round-1 caught Postmark
 * fictions: no HMAC webhooks, no Idempotency-Key header support):
 *   - EU region (eu.resend.com) for GDPR data residency.
 *   - Native attachment support (Base64 in the same /emails POST).
 *   - Documented `Idempotency-Key` header — Resend dedupes within
 *     24h on (key + payload) and returns the cached email id without
 *     a second dispatch. Lines up with our stable per-(daily-list-id,
 *     version) key + force-resend nonce strategy.
 *   - Svix-signed webhooks (Svix-Id, Svix-Timestamp, Svix-Signature
 *     headers; HMAC-SHA256 over `${id}.${ts}.${body}` with the
 *     base64-decoded shared secret).
 *
 * Env config:
 *   RESEND_API_KEY                — required.
 *   RESEND_DEFAULT_FROM_EMAIL     — required (must be a verified domain).
 *   RESEND_DEFAULT_FROM_NAME      — optional, defaults to 'Prequest'.
 *   RESEND_WEBHOOK_SECRET         — required for verifyWebhook(). The
 *                                   `whsec_<base64>` token Resend shows
 *                                   on the webhook setup page.
 */
@Injectable()
export class ResendMailProvider implements MailProvider {
  private readonly apiKey       = process.env.RESEND_API_KEY ?? '';
  private readonly defaultFrom  = process.env.RESEND_DEFAULT_FROM_EMAIL ?? '';
  private readonly defaultName  = process.env.RESEND_DEFAULT_FROM_NAME ?? 'Prequest';
  private readonly webhookSecretRaw = process.env.RESEND_WEBHOOK_SECRET ?? '';

  /** Resend's primary endpoint (auto-routes to nearest region). */
  private static readonly ENDPOINT = 'https://api.resend.com/emails';
  /** Svix timestamp tolerance (seconds). */
  private static readonly WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

  async send(message: MailMessage): Promise<MailSendResult> {
    if (!this.apiKey) {
      throw new BadRequestException('RESEND_API_KEY not configured — cannot dispatch mail.');
    }
    if (!this.defaultFrom) {
      throw new BadRequestException('RESEND_DEFAULT_FROM_EMAIL not configured — cannot dispatch mail.');
    }

    const fromHeader = `${escapeQuoted(message.fromName ?? this.defaultName)} <${message.from || this.defaultFrom}>`;
    const toHeader = message.toName
      ? `${escapeQuoted(message.toName)} <${assertNoCommaOrLineBreak(message.to)}>`
      : assertNoCommaOrLineBreak(message.to);

    const payload: Record<string, unknown> = {
      from:    fromHeader,
      to:      [toHeader],
      subject: message.subject,
      text:    message.textBody,
    };
    if (message.htmlBody) payload.html      = message.htmlBody;
    if (message.replyTo)  payload.reply_to  = assertNoCommaOrLineBreak(message.replyTo);
    if (message.tags) {
      payload.tags = Object.entries(message.tags).map(([name, value]) => ({
        name,
        value: String(value).slice(0, 256),
      }));
    }
    if (message.attachments?.length) {
      payload.attachments = message.attachments.map(serializeAttachment);
    }

    const headers: Record<string, string> = {
      'Accept':        'application/json',
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
    /* Resend `Idempotency-Key` header — provider dedupes within 24h on
       (key + payload). Stable per (daily-list-id, version); force
       resends append a nonce to override the cached result. */
    if (message.idempotencyKey) {
      headers['Idempotency-Key'] = message.idempotencyKey;
    }

    let res: Response;
    try {
      res = await fetch(ResendMailProvider.ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Resend request failed: ${msg}`);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new BadRequestException(`Resend returned non-JSON (${res.status})`);
    }
    if (!res.ok) {
      const errorName = (body as { name?: string })?.name ?? 'unknown';
      const errorMsg  = (body as { message?: string })?.message ?? `Resend ${res.status}`;
      throw new BadRequestException(`Resend ${res.status} (${errorName}): ${errorMsg}`);
    }
    const ok = body as { id: string };
    return {
      messageId:  ok.id,
      acceptedAt: new Date().toISOString(),
    };
  }

  /**
   * Verify the Svix signature on a Resend webhook delivery.
   *
   * Headers:
   *   svix-id         — unique webhook delivery id
   *   svix-timestamp  — seconds since epoch
   *   svix-signature  — space-separated `v1,<base64hmac>` versions
   *
   * Secret is `whsec_<base64-key>`; strip the prefix and base64-decode.
   * HMAC-SHA256 input is the literal `${id}.${ts}.${body}` string.
   */
  verifyWebhook(args: VerifyWebhookArgs): MailWebhookEvent[] {
    if (!this.webhookSecretRaw) {
      throw new UnauthorizedException('RESEND_WEBHOOK_SECRET not configured');
    }
    const secret = parseSvixSecret(this.webhookSecretRaw);

    const id = headerValue(args.headers, 'svix-id');
    const ts = headerValue(args.headers, 'svix-timestamp');
    const sigList = headerValue(args.headers, 'svix-signature');
    if (!id || !ts || !sigList) {
      throw new UnauthorizedException('missing svix-id / svix-timestamp / svix-signature header');
    }

    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) {
      throw new UnauthorizedException('invalid svix-timestamp');
    }
    const ageSec = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
    if (ageSec > ResendMailProvider.WEBHOOK_TOLERANCE_SECONDS) {
      throw new UnauthorizedException(`svix-timestamp out of tolerance (${ageSec}s)`);
    }

    const raw = typeof args.rawBody === 'string'
      ? Buffer.from(args.rawBody, 'utf8')
      : args.rawBody;
    const signedPayload = `${id}.${ts}.${raw.toString('utf8')}`;
    const expected = createHmac('sha256', secret).update(signedPayload).digest();

    const matched = sigList.split(' ').some((entry) => {
      const [version, encoded] = entry.split(',');
      if (version !== 'v1' || !encoded) return false;
      let provided: Buffer;
      try {
        provided = Buffer.from(encoded, 'base64');
      } catch {
        return false;
      }
      if (provided.length !== expected.length) return false;
      return timingSafeEqual(provided, expected);
    });
    if (!matched) {
      throw new UnauthorizedException('invalid Svix signature');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new BadRequestException('webhook body is not valid JSON');
    }
    /* Resend sends one event per webhook POST. */
    const ev = this.translateResendEvent(parsed);
    return ev ? [ev] : [];
  }

  private translateResendEvent(payload: unknown): MailWebhookEvent | null {
    const ev = payload as {
      type?: string;
      created_at?: string;
      data?: Record<string, unknown>;
    };
    if (!ev?.type || !ev.data) return null;
    const data = ev.data;
    const messageId = String(data.email_id ?? data.id ?? '');
    const recipient = Array.isArray(data.to)
      ? String((data.to as unknown[])[0] ?? '')
      : String(data.to ?? '');
    /* Codex round-2 fix: use the TOP-LEVEL `created_at` (event time —
       when the delivery / bounce happened), not data.created_at (email
       creation time). Falls back to data.created_at for older payload
       shapes, then to wall-clock as last resort. */
    const at = String(ev.created_at ?? data.created_at ?? new Date().toISOString());

    switch (ev.type) {
      case 'email.delivered':
        return { type: 'delivered',  providerMessageId: messageId, recipient, at, raw: payload };
      case 'email.bounced':
        return {
          type: 'bounced',
          providerMessageId: messageId,
          recipient,
          at,
          reason:     String((data.bounce as { message?: string })?.message ?? 'bounce'),
          bounceType: mapResendBounceSubtype(String((data.bounce as { subType?: string })?.subType ?? '')),
          raw: payload,
        };
      case 'email.complained':
        return { type: 'complained', providerMessageId: messageId, recipient, at, raw: payload };
      case 'email.delivery_delayed':
      case 'email.failed':
        /* Codex round-2 fix: Resend's failed payload uses
           `data.failed.reason`, not `data.error.message`. Try both
           since Resend has shipped both shapes historically. */
        return {
          type: 'failed',
          providerMessageId: messageId,
          recipient,
          at,
          reason: String(
            (data.failed as { reason?: string })?.reason
            ?? (data.error as { message?: string })?.message
            ?? ev.type,
          ),
          raw: payload,
        };
      case 'email.sent':
      case 'email.opened':
      case 'email.clicked':
        return null;
      default:
        return {
          type: 'failed',
          providerMessageId: messageId,
          recipient,
          at,
          reason: `unknown resend event: ${ev.type}`,
          raw: payload,
        };
    }
  }
}

function serializeAttachment(att: MailAttachment): Record<string, unknown> {
  return {
    filename:     att.filename,
    content:      att.contents.toString('base64'),
    content_type: att.contentType,
  };
}

function escapeQuoted(s: string): string {
  /* Codex round-2 fix: also strip commas (Resend treats `to` as
     comma-separated, so a comma in the display name splits into
     bogus extra recipients) and angle brackets (interfere with the
     "Display Name <email>" parser). CR/LF prevent header injection. */
  return s.replace(/[\r\n",<>]/g, ' ').trim();
}

function assertNoCommaOrLineBreak(addr: string): string {
  if (/[\r\n,]/.test(addr)) {
    throw new BadRequestException(`mail recipient contains illegal character: ${addr}`);
  }
  return addr.trim();
}

function mapResendBounceSubtype(subtype: string): 'hard' | 'soft' | 'block' | 'unknown' {
  /* Codex round-2 fix: Resend's documented values are TitleCase
     ('General', 'Suppressed', 'Transient'). Round-1 mapped lowercase
     and mis-handled real bounces. Lowercase the input + carry both
     historical shapes. */
  const k = subtype.toLowerCase();
  if (k === 'general' || k === 'noemail' || k === 'permanent') return 'hard';
  if (k === 'mailbox-full' || k === 'message-too-large' || k === 'transient') return 'soft';
  if (k === 'suppressed' || k === 'on-account-suppression-list') return 'block';
  return 'unknown';
}

function parseSvixSecret(raw: string): Buffer {
  const trimmed = raw.startsWith('whsec_') ? raw.slice('whsec_'.length) : raw;
  try {
    return Buffer.from(trimmed, 'base64');
  } catch {
    throw new UnauthorizedException('RESEND_WEBHOOK_SECRET is not valid base64');
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (!v) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
}
