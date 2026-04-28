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
export interface DaglijstMailer {
  sendDaglijst(input: SendDaglijstInput): Promise<DaglijstSendResult>;
}

export interface SendDaglijstInput {
  tenantId: string;
  vendorId: string;
  daglijstId: string;
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
   * Stable correlation id for provider-side idempotency. Sprint 4
   * implementations pass this as Postmark MessageStream / Resend
   * Idempotency-Key. Without it, network retries create duplicate sends.
   * Recommended shape: `daglijst:<daglijst_id>:<email_status_attempt>`.
   */
  correlationId: string;
}

export interface DaglijstSendResult {
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
export class LoggingDaglijstMailer implements DaglijstMailer {
  private readonly log = new Logger(LoggingDaglijstMailer.name);

  async sendDaglijst(input: SendDaglijstInput): Promise<DaglijstSendResult> {
    this.log.warn(
      `event=daglijst_send tenant=${input.tenantId} vendor=${input.vendorId} ` +
      `daglijst=${input.daglijstId} email=${input.recipientEmail} ` +
      `subject="${input.subject}" lang=${input.language} ` +
      `pdf_url=${input.pdfDownloadUrl}`,
    );
    return {
      messageId: `dev:${input.daglijstId}:${Date.now()}`,
      acceptedAt: new Date().toISOString(),
    };
  }
}

/** DI token; swap in production via VENDOR_MAILER-style provide useExisting. */
export const DAGLIJST_MAILER = Symbol('DAGLIJST_MAILER');
