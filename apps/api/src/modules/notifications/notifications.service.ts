import { Injectable, Logger } from '@nestjs/common';
import { EmailChannel } from './channels/email.channel';
import type { DispatchInput, DispatchResult } from './channels/notification-channel.interface';
import { TemplateResolverService } from './templates/template-resolver.service';

/**
 * NotificationsService — orchestrates template resolution + per-channel dispatch.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step C.
 *
 * ── Contract surface for sub-step D ─────────────────────────────────────
 *
 * The outbox handler (`booking-approval-required.handler.ts`) calls
 * `dispatch(...)` once per resolved approver user. Each call:
 *   1. Resolves the template (default + tenant override merge).
 *   2. Renders to HTML + text + subject.
 *   3. Hands off to the email channel.
 *
 * Inbox is NOT a channel here — inbox rows are written atomically inside
 * the producer RPC (Hybrid C, locked decision #5). The handler skips
 * inbox; this module skips inbox; the realtime subscription in sub-step F
 * surfaces new rows to users.
 *
 * ── Why a service, not channels-by-channels in the handler ──────────────
 *
 * The handler iterates approvers. Each approver needs (a) template render
 * with their locale + tenant overrides, (b) channel dispatch. Pulling
 * those two steps into a single orchestrator means future channels (Teams
 * in v2) bolt onto NotificationsService.dispatch, not onto the handler
 * loop.
 *
 * ── Idempotency-Key passthrough ─────────────────────────────────────────
 *
 * The handler computes `<event.id>:<userId>` and passes it on every
 * dispatch call. NotificationsService doesn't generate keys — keys are
 * the handler's concern (it knows the outbox event id; this service
 * doesn't).
 */

export interface DispatchArgs {
  /** Tenant boundary. */
  tenantId: string;
  /** Recipient `public.users.id`. */
  userId: string;
  /** Resolved locale (caller defaults to 'en' on NULL). */
  locale: 'en' | 'nl';
  /** Template kind — must be a registered key in TemplateResolverService. */
  eventKind: string;
  /** Typed payload for the kind. */
  payload: Record<string, unknown>;
  /**
   * Provider-level idempotency key. Handler convention:
   *   `<outbox_event_id>:<userId>`
   * — at-least-once outbox delivery × N approvers stays exactly-once at
   * the email provider (Resend dedupes within 24h on key + payload).
   */
  idempotencyKey: string;
  /** Entity context (deep links, audit). */
  context: DispatchInput['context'];
}

@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(
    private readonly templates: TemplateResolverService,
    private readonly email: EmailChannel,
  ) {}

  async dispatch(args: DispatchArgs): Promise<DispatchResult> {
    // ── 1. Render. ──────────────────────────────────────────────────────
    const rendered = await this.templates.resolve({
      tenantId: args.tenantId,
      eventKind: args.eventKind,
      locale: args.locale,
      payload: args.payload,
    });

    // ── 2. Dispatch. ────────────────────────────────────────────────────
    //
    // Only email channel in v1. When Teams ships (v2), this is where
    // per-user channel preferences route the dispatch. For now: every
    // recipient gets email.
    const result = await this.email.dispatch({
      tenantId: args.tenantId,
      userId: args.userId,
      locale: args.locale,
      rendered,
      idempotencyKey: args.idempotencyKey,
      context: args.context,
    });

    if (!result.delivered) {
      this.log.warn(
        `notifications.dispatch.undelivered: tenant=${args.tenantId} user=${args.userId} kind=${args.eventKind} channel=${result.channelId}`,
      );
    }
    return result;
  }
}
