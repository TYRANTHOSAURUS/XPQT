import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppErrors } from '../../../common/errors';
import { MAIL_PROVIDER, type MailProvider } from '../../../common/mail/mail-provider';
import { SupabaseService } from '../../../common/supabase/supabase.service';
import type {
  DispatchInput,
  DispatchResult,
  NotificationChannel,
} from './notification-channel.interface';

/**
 * EmailChannel — Resend-backed email delivery for notification dispatch.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step C.
 *
 * ── Why this wraps MAIL_PROVIDER instead of installing the `resend` SDK ──
 *
 * The platform already ships a Resend adapter at
 * apps/api/src/common/mail/resend-mail-provider.ts that the daily-list +
 * vendor-portal flows depend on. It already supports:
 *   - EU residency (account-level API key region),
 *   - Idempotency-Key header (Resend dedupes for 24h on key + payload),
 *   - Webhook verification (Svix-signed),
 *   - AppError mapping for vendor errors via `mail.dispatch_failed`,
 *   - Header injection escaping.
 *
 * Duplicating it as a standalone Resend SDK call inside this module would
 * fragment the mail substrate (two webhook receivers, two bounce-handling
 * paths, two sets of credentials) and contradicts the explicit Codex
 * 2026-04-28 recommendation to keep one provider adapter for ALL
 * platform mail. So EmailChannel takes the `NotificationChannel` shape
 * (Teams-ready per architect I4) and delegates to MAIL_PROVIDER underneath.
 *
 * Per-tenant routing (tenant A on Resend, tenant B on SES) — sprint 5,
 * same as the existing mail substrate.
 *
 * ── User → email resolution ──
 *
 * Recipients are `public.users.id` values. The lookup filters by tenant_id
 * (memory: feedback_tenant_id_ultimate_rule — #0 invariant). If the user
 * row is missing or has no email, the channel returns `{ delivered: false }`
 * with a warn log. No throw — the outbox handler should not retry on a
 * permanent "user can't receive email" condition.
 *
 * ── Vendor-error mapping ──
 *
 * MAIL_PROVIDER throws `AppError(mail.dispatch_failed)` on Resend rejections.
 * We re-throw as `email.dispatch_failed` (the registered code for this
 * module's failure mode) so the outbox handler retry/dead-letter machinery
 * sees a typed AppError, not the underlying mail.* class.
 */

export interface EmailChannelConfig {
  /** Sender email — must match a verified Resend domain. */
  fromEmail: string;
  /** Sender display name shown in the email envelope. */
  fromName?: string;
}

@Injectable()
export class EmailChannel implements NotificationChannel {
  readonly id = 'email' as const;
  private readonly log = new Logger(EmailChannel.name);
  private readonly config: EmailChannelConfig;

  constructor(
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
    private readonly supabase: SupabaseService,
  ) {
    this.config = {
      fromEmail: process.env.RESEND_FROM_EMAIL
        ?? process.env.RESEND_DEFAULT_FROM_EMAIL
        ?? 'notifications@prequest.app',
      fromName: process.env.RESEND_FROM_NAME
        ?? process.env.RESEND_DEFAULT_FROM_NAME
        ?? 'Prequest',
    };
  }

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    // ── 1. Resolve user → email in tenant scope. ────────────────────────
    //
    // Cross-tenant defense: supabase.admin bypasses RLS, so we filter by
    // (tenant_id, id) explicitly. A cross-tenant or colliding user id
    // would otherwise leak. Pattern matches branding.service.ts.
    const { data: user, error: userError } = await this.supabase.admin
      .from('users')
      .select('id, email')
      .eq('id', input.userId)
      .eq('tenant_id', input.tenantId)
      .maybeSingle();

    if (userError) {
      this.log.warn(
        `email.channel.user_lookup_failed: tenant=${input.tenantId} user=${input.userId} ${userError.message}`,
      );
      // Treat as undeliverable rather than a hard failure — a transient
      // supabase blip would otherwise dead-letter the outbox event. The
      // outbox handler's own retry covers genuine errors.
      return { channelId: 'email', delivered: false };
    }

    if (!user || !user.email) {
      this.log.warn(
        `email.channel.no_email: tenant=${input.tenantId} user=${input.userId} ` +
          `(user ${user ? 'has no email column value' : 'not found'})`,
      );
      return { channelId: 'email', delivered: false };
    }

    // ── 2. Hand off to MAIL_PROVIDER. ────────────────────────────────────
    //
    // MAIL_PROVIDER already maps Resend rejections to AppError(mail.dispatch_failed)
    // with vendor names scrubbed. We catch + re-throw as email.dispatch_failed
    // so the outbox handler sees a typed code that's registered in
    // packages/shared/src/error-codes.ts:75,950 and messages.{en,nl}.ts.
    try {
      const result = await this.mail.send({
        tenantId:     input.tenantId,
        to:           user.email,
        from:         this.config.fromEmail,
        fromName:     this.config.fromName,
        subject:      input.rendered.subject,
        textBody:     input.rendered.text,
        htmlBody:     input.rendered.html,
        idempotencyKey: input.idempotencyKey,
        messageStream: 'transactional',
        tags: {
          channel: 'notifications',
          entity_type: input.context.entityType,
          entity_id: input.context.entityId,
        },
      });
      return {
        channelId: 'email',
        externalId: result.messageId,
        delivered: true,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.log.warn(
        `email.channel.dispatch_failed: tenant=${input.tenantId} user=${input.userId} ${detail}`,
      );
      throw AppErrors.server('email.dispatch_failed', { detail });
    }
  }
}
