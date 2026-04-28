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
   * Plain-text body. Sprint 4 wires HTML templates; Sprint 2 ships text-
   * only so the spec-required body content (date, location count, total
   * quantity, link) is delivery-channel-agnostic.
   */
  textBody: string;
  /** Signed URL to the PDF in Supabase Storage; TTL ≤ 1 hour. */
  pdfDownloadUrl: string;
  language: string;            // 'nl' | 'fr' | 'en' | 'de' for future templates
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
