/**
 * Shared mail-delivery substrate for the platform.
 *
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-b-design.md §11
 *  + docs/superpowers/specs/2026-04-27-vendor-portal-phase-a-daglijst-design.md §6.
 *
 * Two callers reuse this:
 *   1. VendorMailer (vendor-portal) — magic-link login emails.
 *   2. DailyListMailer (daily-list)  — paper-vendor daily-list emails
 *      with PDF attachment.
 *
 * Why a single provider abstraction:
 *   - Both flows need EU residency, idempotency keys, attachment
 *     support, and signed delivery webhooks.
 *   - Splitting into two adapters duplicates the credentials, the
 *     webhook receiver, and the bounce-handling state.
 *   - Codex 2026-04-28 review explicitly recommended one provider
 *     adapter for both surfaces.
 *
 * Design constraints:
 *   - Provider-agnostic interface so swapping Postmark↔Resend↔SES is a
 *     single-file change.
 *   - Idempotency-key support is REQUIRED (the daily-list send path
 *     ships a stable per-(row, version) correlationId; the provider
 *     must dedupe duplicate sends).
 *   - Buffered attachments are first-class (not links). Paper vendors
 *     print directly from the attachment; signed-URL-only delivery is
 *     a regression in that workflow.
 */
export interface MailProvider {
  send(message: MailMessage): Promise<MailSendResult>;

  /**
   * Verify a webhook payload's signature against the provider's shared
   * secret. Throws if invalid; returns the parsed event(s) if valid.
   * Per-provider semantics — Postmark sends a header HMAC, Resend
   * uses Svix-style signing. Implementations document their headers.
   */
  verifyWebhook(args: VerifyWebhookArgs): MailWebhookEvent[];
}

export interface MailMessage {
  to: string;
  toName?: string | null;
  /** Sender email — must match a verified domain on the provider side. */
  from: string;
  fromName?: string;
  /** Optional Reply-To. Not used today; Sprint 4 follow-up for vendor->tenant replies. */
  replyTo?: string;
  subject: string;
  textBody: string;
  htmlBody?: string | null;
  /**
   * Per-attempt idempotency key. Same key + same content → provider
   * returns the cached send (no duplicate dispatch). Daily-list
   * uses a stable per-(row, version) shape so cross-worker race
   * retries get deduped at the provider; force resends append a
   * nonce to override the cache.
   */
  idempotencyKey?: string;
  /**
   * Per-tenant message stream / category — Postmark's MessageStream
   * concept; Resend's tag concept. Drives which provider template the
   * message belongs to and which bounce-rate budget it consumes.
   */
  messageStream?: 'transactional' | 'broadcast' | string;
  attachments?: MailAttachment[];
  /** Tags surfaced on the webhook event so the receiver can route by category. */
  tags?: Record<string, string>;
  /** Tenant the message is FROM, for audit / quota / billing. */
  tenantId: string;
}

export interface MailAttachment {
  filename: string;
  contentType: string;             // 'application/pdf', 'image/png', ...
  /** Inline bytes — required. Storage-path fetching is the provider's job. */
  contents: Buffer;
  /** When set, attach inline (cid: reference) instead of as an attachment. */
  inlineCid?: string;
}

export interface MailSendResult {
  /** Provider-side message id; goes into vendor_daily_lists.email_message_id. */
  messageId: string;
  /** Provider's accepted-at timestamp (ISO). */
  acceptedAt: string;
}

export interface VerifyWebhookArgs {
  /**
   * Raw body bytes — REQUIRED. Postmark / Resend signatures are over
   * the exact bytes the client received. Don't pre-parse JSON before
   * verify — JSON re-stringify mutates whitespace and breaks the sig.
   */
  rawBody: Buffer | string;
  /** All inbound headers, lower-cased keys. */
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Normalised webhook event — what the receiver gets after verify. Each
 * provider maps its native event shape into this union. Today only the
 * delivery-state events that the daily-list state machine consumes are
 * modelled; Sprint 5 adds open / click for engagement metrics.
 */
export type MailWebhookEvent =
  | { type: 'delivered';  providerMessageId: string; recipient: string; at: string;
      raw: unknown }
  | { type: 'bounced';    providerMessageId: string; recipient: string; at: string;
      reason: string;     bounceType: 'hard' | 'soft' | 'block' | 'unknown';
      raw: unknown }
  | { type: 'complained'; providerMessageId: string; recipient: string; at: string;
      raw: unknown }
  | { type: 'failed';     providerMessageId: string; recipient: string; at: string;
      reason: string;     raw: unknown };

/** DI token. */
export const MAIL_PROVIDER = Symbol('MAIL_PROVIDER');
