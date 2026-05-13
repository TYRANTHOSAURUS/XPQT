/**
 * NotificationChannel — uniform dispatch surface across delivery providers.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step C (architect I4 — Teams-ready interface).
 *
 * Two channels ship in B.4.A.5:
 *   - email  — EmailChannel wraps MAIL_PROVIDER (Resend in prod; logging in dev).
 *   - inbox  — NOT a v1 channel. Inbox rows are written inside the producer
 *              RPC (Hybrid C, plan-review locked decision #5). The handler in
 *              sub-step D dispatches email only; inbox visibility is realtime.
 *
 * One channel scoped for v2+ (interface designed Teams-ready per architect I4):
 *   - teams  — adaptive-card POST to a per-user channel webhook. Adaptive
 *              cards reference `context.callbackBaseUrl` to render an
 *              Approve/Reject action that hits our API. The `context` bag
 *              is optional today (email doesn't read it) so adding Teams
 *              later is a new channel class + wiring change, not an
 *              interface change.
 *
 * Cross-tenant note: `tenantId` is on the dispatch input. Every channel
 * implementation MUST filter every DB query by `tenantId`. Mail provider
 * itself is tenant-agnostic (the platform owns the sender domain in v1),
 * but the channel adapter that owns the recipient lookup is responsible.
 */

export interface NotificationChannel {
  /** Stable identifier — used for routing + audit. */
  readonly id: 'email' | 'inbox' | 'teams';
  dispatch(input: DispatchInput): Promise<DispatchResult>;
}

export interface DispatchInput {
  /** Tenant boundary. #0 invariant — every DB read inside the channel filters by this. */
  tenantId: string;
  /**
   * Target `public.users.id` (NOT auth.uid, NOT persons.id). The channel
   * resolves user → contact info (email, Teams channel id, etc.) in the
   * tenant scope.
   */
  userId: string;
  /** Resolved locale — 'en' or 'nl'. Caller handles fallback before this point. */
  locale: 'en' | 'nl';
  /** Pre-rendered notification copy (subject + body + CTA). */
  rendered: RenderedNotification;
  /**
   * Provider-level idempotency key — for Resend, becomes the Idempotency-Key
   * header. The outbox handler computes this as `<event.id>:<userId>` so
   * at-least-once outbox delivery doesn't cause duplicate emails.
   *
   * Plan-review I4 / `/tmp/b4a5-plan-v2.md` sub-step C.
   */
  idempotencyKey: string;
  /**
   * Context for channels that need entity reference + deep links at
   * dispatch time. Email + inbox don't read these today; Teams adaptive
   * cards will require `callbackBaseUrl` once implemented.
   *
   * Architect I4 — `/tmp/b4a5-plan-v2.md` sub-step C.
   */
  context: {
    /** e.g. 'booking' — for audit + deep-link routing. */
    entityType: string;
    /** UUID of the referenced row. */
    entityId: string;
    /** Tenant slug for sub-domain composition in deep links. */
    tenantSlug: string;
    /** Reserved for Teams + future channels that need a stable callback origin. */
    callbackBaseUrl?: string;
  };
}

/**
 * Pre-rendered notification copy. TemplateResolverService produces this
 * from the (event_kind, locale, payload) tuple + tenant overrides.
 */
export interface RenderedNotification {
  subject: string;
  /** Rich HTML body — React Email render output. */
  html: string;
  /** Plain-text body — React Email plain-text render output. */
  text: string;
  /** Localised CTA button text (e.g. "View booking" / "Bekijk reservering"). */
  ctaText?: string;
  /** Absolute URL for the CTA button. Built from WEB_BASE_URL + entity path. */
  ctaUrl?: string;
}

export interface DispatchResult {
  /** Echo of the channel id that handled this dispatch. */
  channelId: 'email' | 'inbox' | 'teams';
  /** Provider message id for audit (e.g. Resend `email_id`). Optional. */
  externalId?: string;
  /**
   * `false` when the channel intentionally skipped (e.g. user has no email
   * on file). Caller decides whether to log a warning vs. retry — but a
   * `false` is NOT a failure (no throw, no retry).
   */
  delivered: boolean;
}
