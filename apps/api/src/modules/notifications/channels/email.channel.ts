import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
 * (memory: feedback_tenant_id_ultimate_rule — #0 invariant).
 *
 * Self-review I1: distinguish PERMANENT vs TRANSIENT failure on the user
 * lookup:
 *   - PERMANENT (user not found, has no email column value) → return
 *     `{ delivered: false }` with a warn. Retrying won't help — the
 *     outbox handler logs + drops; ops triages.
 *   - TRANSIENT (Supabase error — DB blip, network reset) → throw
 *     `AppError(email.dispatch_failed)`. The outbox handler's retry
 *     machinery picks it up; otherwise we'd permanently lose the
 *     notification on a recoverable error.
 *
 * ── Vendor-error mapping ──
 *
 * MAIL_PROVIDER throws `AppError(mail.dispatch_failed)` on Resend rejections.
 * We re-throw as `email.dispatch_failed` (the registered code for this
 * module's failure mode) so the outbox handler retry/dead-letter machinery
 * sees a typed AppError, not the underlying mail.* class.
 *
 * ── Configuration loading (self-review C2) ──
 *
 * Constructor reads `process.env.RESEND_FROM_EMAIL` directly was the EXACT
 * bug pattern codex 2026-04-28 round-1 caught in `mail.module.ts:23-44` —
 * provider/config selection at module-import time read process.env BEFORE
 * `ConfigModule.forRoot()` loaded `.env`, leaving prod permanently bound
 * to the dev fallback. The fix mirrors that file: inject ConfigService;
 * read env at dispatch time (not constructor); ConfigService is sourced
 * from `ConfigModule.forRoot({ isGlobal: true, envFilePath: ... })` in
 * AppModule which guarantees `.env` is loaded before any provider
 * instantiation.
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

  constructor(
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Resolve sender config at dispatch time (NOT constructor).
   *
   * Self-review C2: constructor-cached `process.env.*` reads are the exact
   * codex 2026-04-28 bug pattern. ConfigService.get reads from the
   * already-loaded `.env` (ConfigModule.forRoot is processed before any
   * provider construction in AppModule).
   */
  private resolveSenderConfig(): EmailChannelConfig {
    return {
      fromEmail:
        this.config.get<string>('RESEND_FROM_EMAIL')
        ?? this.config.get<string>('RESEND_DEFAULT_FROM_EMAIL')
        ?? 'notifications@prequest.app',
      fromName:
        this.config.get<string>('RESEND_FROM_NAME')
        ?? this.config.get<string>('RESEND_DEFAULT_FROM_NAME')
        ?? 'Prequest',
    };
  }

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const senderConfig = this.resolveSenderConfig();

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
      // Self-review I1: a Supabase error (DB blip, network reset) is a
      // TRANSIENT failure. Throw so the outbox retry picks it up.
      // Returning `delivered: false` here would dead-letter recoverable
      // errors and permanently lose the notification.
      throw AppErrors.server('email.dispatch_failed', {
        detail: `user_lookup_failed: ${userError.message}`,
      });
    }

    if (!user || !user.email) {
      this.log.warn(
        `email.channel.no_email: tenant=${input.tenantId} user=${input.userId} ` +
          `(user ${user ? 'has no email column value' : 'not found'})`,
      );
      // PERMANENT: retrying won't help. Outbox handler logs + drops.
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
        from:         senderConfig.fromEmail,
        fromName:     senderConfig.fromName,
        subject:      input.rendered.subject,
        textBody:     input.rendered.text,
        htmlBody:     input.rendered.html,
        idempotencyKey: input.idempotencyKey,
        messageStream: 'transactional',
        // input.context.tenantSlug + callbackBaseUrl are reserved for the
        // future Teams adapter (adaptive cards need to render the tenant
        // identity in the card UI + Approve/Reject callbacks need a stable
        // origin). Email channel intentionally ignores them — see
        // notification-channel.interface.ts:60-69. Self-review I5.
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
