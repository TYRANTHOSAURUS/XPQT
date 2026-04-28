import { Injectable, Logger } from '@nestjs/common';

/**
 * Outbound delivery for daglijst PDFs. Same architecture as
 * VendorMailer (Phase B Sprint 1) — Sprint 2 ships a logging-only
 * implementation; Sprint 4 swaps in real EU email delivery.
 *
 * Mirroring the vendor-portal pattern intentionally: when Phase B Sprint 4
 * lands the real email provider integration, we wire the same provider
 * here through the same DI token.
 *
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-a-daglijst-design.md §6.
 */
export interface DailyListMailer {
  sendDailyList(input: SendDailyListInput): Promise<DailyListSendResult>;
}

export interface SendDailyListInput {
  tenantId: string;
  vendorId: string;
  dailyListId: string;
  recipientEmail: string;
  vendorName: string;
  /** Pre-formatted human-readable subject for the email. */
  subject: string;
  /**
   * Plain-text body — always provided; Sprint 4 ships htmlBody alongside
   * for the branded version. The spec-required body content (date,
   * location count, total quantity, link) lives here.
   */
  textBody: string;
  /**
   * Optional HTML body. Sprint 2 leaves null; Sprint 4 emits a branded
   * email-template render alongside text fallback. Mailers that only
   * support multipart should fall back to textBody.
   */
  htmlBody?: string | null;
  /**
   * Signed URL to the PDF in Supabase Storage. Sprint 2 ships only this
   * (link in body); Sprint 4 may switch to actual attachment per spec §6.
   */
  pdfDownloadUrl: string;
  /**
   * Optional PDF attachment payload. Sprint 4 wires either the in-memory
   * buffer (for fresh renders) or a storage_path the mailer can fetch
   * server-side. Sprint 2's logging mailer ignores this field.
   */
  attachment?: {
    filename: string;          // e.g. 'daglijst-2026-05-01-v1.pdf'
    contentType: 'application/pdf';
    /** Either inline bytes OR a storage path the mailer fetches. */
    bytes?: Buffer;
    storagePath?: string;
    /** When storagePath is set, which bucket. */
    storageBucket?: string;
  } | null;
  language: string;            // 'nl' | 'fr' | 'en' | 'de'
  /**
   * Stable correlation id for provider-side idempotency.
   *
   * Sprint 4 implementations MUST pass this as Postmark MessageStream /
   * Resend / SES Idempotency-Key so:
   *  1. Network retries to the provider don't create duplicate sends
   *     (provider returns the cached success).
   *  2. Cross-worker race retries (worker A's lease revoked by sweeper,
   *     worker B retries the same logical delivery) get deduped — same
   *     correlationId returns the cached receipt without dispatching
   *     a second email to the vendor.
   *
   * DailyListService always supplies one. Shape:
   *   - natural send:  `daily-list:<daglijst_id>:v<n>`        (stable)
   *   - force resend:  `daily-list:<daglijst_id>:v<n>:force:<nonce>`
   *
   * The stable shape is REQUIRED for the cross-worker dedupe to work —
   * codex round-3 review caught a regression where a per-attempt nonce
   * defeated this guarantee.
   *
   * Optional at the interface level so non-Sprint-2 callers and external
   * mailer implementations don't need to retrofit, but Sprint 4 mailers
   * SHOULD treat it as required.
   */
  correlationId?: string;
}

export interface DailyListSendResult {
  /** Provider-side message id. Sprint 2 logging mailer returns a synthetic id. */
  messageId: string;
  acceptedAt: string;
}

/**
 * Sprint 2 dev-mode mailer. Logs the would-have-been email at info level
 * so an operator running locally can copy the signed URL out of the log
 * stream. Stores nothing — the only persistent record is the
 * vendor_daily_lists row that recorded `recipient_email` + `pdf_storage_path`.
 *
 * Production (Sprint 4) plugs into the same interface and dispatches via
 * Postmark/Resend EU.
 */
@Injectable()
export class LoggingDailyListMailer implements DailyListMailer {
  private readonly log = new Logger(LoggingDailyListMailer.name);

  async sendDailyList(input: SendDailyListInput): Promise<DailyListSendResult> {
    this.log.warn(
      `event=daily_list_send tenant=${input.tenantId} vendor=${input.vendorId} ` +
      `daily_list=${input.dailyListId} email=${input.recipientEmail} ` +
      `subject="${input.subject}" lang=${input.language} ` +
      `pdf_url=${input.pdfDownloadUrl}`,
    );
    return {
      messageId: `dev:${input.dailyListId}:${Date.now()}`,
      acceptedAt: new Date().toISOString(),
    };
  }
}

/** DI token; swap in production via VENDOR_MAILER-style provide useExisting. */
export const DAILY_LIST_MAILER = Symbol('DAILY_LIST_MAILER');
