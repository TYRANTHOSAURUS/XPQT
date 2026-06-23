/**
 * Typed payload contracts per notification event kind.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step C.
 *
 * Each event kind ships:
 *   - one Payload type (defines the strongly-typed render input),
 *   - one default English template module,
 *   - one default Dutch template module,
 *   - optional per-tenant overrides stored in
 *     `public.notification_template_overrides`.
 *
 * The TemplateResolverService wires the kind → template module mapping
 * and applies override merging at render time.
 */

/** Subset of a `notification_template_overrides` row, trimmed + null-coerced. */
export interface TemplateOverrides {
  subject?: string | null;
  ctaText?: string | null;
  bodyIntro?: string | null;
}

/** Output of the template's `renderSubject` + the React component render. */
export interface RenderedTemplate {
  subject: string;
  html: string;
  text: string;
  ctaText?: string;
  ctaUrl?: string;
}

/**
 * Each template module exports this shape — a pure render + a subject
 * builder. Both take the typed payload + optional overrides; subject is
 * separate because React Email rendering produces body HTML/text but not
 * the email-envelope subject.
 */
export interface TemplateModule<P> {
  /** Build the email subject from payload + (optional) override. */
  renderSubject(payload: P, overrides: TemplateOverrides): string;
  /**
   * Default React component for the body. Typed as React.FC at the call
   * site (not here — keeping this interface react-agnostic so the type
   * file stays import-light). The resolver casts to React.FC at render
   * time.
   */
  Component: import('react').FC<{ payload: P; overrides: TemplateOverrides }>;
}

// ── booking.approval_required ───────────────────────────────────────────────

/**
 * Payload for the `booking.approval_required` notification.
 *
 * Producer: edit_booking RPC v5 (00393) emits the outbox event; the
 * handler in sub-step D enriches with booking + space + requester
 * details before calling NotificationsService.dispatch.
 *
 * Hidden-vendor rule (memory: feedback_hide_vendor_from_requester) does
 * NOT apply here — recipients are approvers (operators / managers), not
 * the booking requester. They may see operational detail.
 */
export interface BookingApprovalRequiredPayload {
  /** UUID of the booking row (aggregate). */
  bookingId: string;
  /** UUID of the approval chain row. Used by the inbox dedup index. */
  chainId: string;
  /** Human-readable title of the booking — falls back to space name when empty. */
  bookingTitle: string;
  /** Display name of the requester (firstName + lastName). */
  requesterName: string;
  /** Display name of the booked space. */
  spaceName: string;
  /** ISO-8601 start timestamp (UTC). */
  startAt: string;
  /** ISO-8601 end timestamp (UTC). */
  endAt: string;
  /**
   * Absolute URL the CTA button links to. Built by the dispatch caller
   * from WEB_BASE_URL + `/desk/approvals` (or booking detail when the
   * approvals page hasn't shipped yet — architect I1).
   */
  approvalCtaUrl: string;
  /**
   * Absolute URL of the portal-side equivalent — used when the recipient
   * is viewing their inbox on the employee portal (no /desk/ access).
   * Optional for back-compat with older queued payloads; the frontend
   * falls back to rewriting approvalCtaUrl when absent.
   */
  portalUrl?: string;
}
