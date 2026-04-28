import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import {
  MAIL_PROVIDER,
  type MailProvider,
} from '../../common/mail/mail-provider';

/**
 * Outbound delivery for daily-list (NL: "daglijst") PDFs.
 *
 * Sprint 4 rework — codex 2026-04-28 review specifically called out:
 *   "rework Sprint 4 to be attachment-first, not signed-URL-first.
 *    For paper vendors, printable PDF in inbox is the product."
 *
 * Implementation (this file):
 *   - Fetch the rendered PDF buffer from Supabase Storage by path (NOT
 *     re-render — the buffer was already produced + uploaded by
 *     DailyListService.renderAndUpload).
 *   - Hand the buffer to the shared MailProvider as a real
 *     attachment alongside a signed URL fallback in the body.
 *   - Stable per-(daily-list-id, version) idempotency key so the mail
 *     provider dedupes cross-worker race retries (codex Sprint 2
 *     round-3 fix). Force resends append a nonce; the caller in
 *     DailyListService.send() sets that.
 *
 * The previous dual-mailer (Logging vs real) split is collapsed —
 * MAIL_PROVIDER is the seam. Tests bind LoggingMailProvider; staging /
 * prod bind PostmarkMailProvider.
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
  subject: string;
  textBody: string;
  htmlBody?: string | null;
  /** Signed URL fallback in case the attachment fails to deliver. */
  pdfDownloadUrl: string;
  /**
   * Storage path of the rendered PDF (vendor_daily_lists.pdf_storage_path).
   * The mailer reads the file bytes here and ships them as a real
   * attachment. Codex Sprint 4 rework: attachment-first, not link-first.
   */
  pdfStoragePath: string;
  /** Storage bucket for the PDF (defaults to 'daglijst-pdfs'). */
  pdfStorageBucket?: string;
  /** Filename the recipient sees on the attachment. */
  pdfFilename: string;
  language: string;
  correlationId?: string;
}

export interface DailyListSendResult {
  messageId: string;
  acceptedAt: string;
}

/** DI token for tests / Sprint-5 alternate impls. */
export const DAILY_LIST_MAILER = Symbol('DAILY_LIST_MAILER');

/**
 * Production daily-list mailer. Routes through the shared MailProvider
 * (Postmark in production, LoggingMailProvider in dev / tests).
 */
@Injectable()
export class ProviderDailyListMailer implements DailyListMailer {
  private readonly log = new Logger(ProviderDailyListMailer.name);
  private readonly fromEmail = process.env.DAILY_LIST_FROM_EMAIL
    ?? process.env.POSTMARK_DEFAULT_FROM_EMAIL
    ?? 'noreply@prequest.io';
  private readonly fromName = process.env.DAILY_LIST_FROM_NAME ?? 'Prequest';
  private static readonly DEFAULT_BUCKET = 'daglijst-pdfs';

  constructor(
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
    private readonly supabase: SupabaseService,
  ) {}

  async sendDailyList(input: SendDailyListInput): Promise<DailyListSendResult> {
    const bucket = input.pdfStorageBucket ?? ProviderDailyListMailer.DEFAULT_BUCKET;

    /* Fetch the rendered PDF bytes from Storage. The DailyListService
       just uploaded them in the same flow, so this is normally a hot
       cache hit. Fail loudly — the spec calls for attachment delivery
       and silently downgrading to link-only would defeat the change. */
    const dl = await this.supabase.admin.storage.from(bucket).download(input.pdfStoragePath);
    if (dl.error || !dl.data) {
      throw new Error(
        `daily-list PDF download failed for path=${input.pdfStoragePath}: ${dl.error?.message ?? 'no data'}`,
      );
    }
    const buffer = Buffer.from(await dl.data.arrayBuffer());

    const result = await this.mail.send({
      tenantId: input.tenantId,
      from: this.fromEmail,
      fromName: this.fromName,
      to: input.recipientEmail,
      toName: input.vendorName,
      subject: input.subject,
      textBody: input.textBody,
      htmlBody: input.htmlBody ?? null,
      idempotencyKey: input.correlationId,
      messageStream: 'transactional',
      tags: {
        entity_type: 'vendor_daily_list',
        daily_list_id: input.dailyListId,
        vendor_id: input.vendorId,
        language: input.language,
      },
      attachments: [
        {
          filename: input.pdfFilename,
          contentType: 'application/pdf',
          contents: buffer,
        },
      ],
    });

    this.log.log(
      `daily-list ${input.dailyListId} dispatched via mail provider ` +
      `provider_msg=${result.messageId} attachment_bytes=${buffer.length}`,
    );

    return result;
  }
}
