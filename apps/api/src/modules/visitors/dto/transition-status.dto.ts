/**
 * Internal-only DTO for VisitorService.transitionStatus.
 *
 * NOT exposed via REST as a freeform endpoint — every state change is
 * triggered by a domain action (host-initiated cancel, reception check-in,
 * EOD sweep, approval decision, bundle cascade). Each of those code paths
 * builds the appropriate options and calls `transitionStatus` directly.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §5
 */

export type VisitorStatus =
  | 'pending_approval'
  | 'expected'
  | 'arrived'
  | 'in_meeting'
  | 'checked_out'
  | 'no_show'
  | 'cancelled'
  | 'denied';

/** Source of a checkout event. Mirrored by the SQL CHECK on visitors.checkout_source. */
export type CheckoutSource = 'reception' | 'host' | 'eod_sweep';

export interface TransitionStatusOpts {
  /**
   * Override for `arrived_at` when transitioning to `arrived`. Reception
   * supports backdated entry per spec §7.5 ("the visitor showed up at 8:55
   * but I'm logging it at 9:10"). When omitted, defaults to now().
   * `logged_at` is always set to now() on `arrived` (the
   * visitors_logged_after_arrived CHECK enforces logged_at >= arrived_at).
   */
  arrived_at?: string;       // ISO 8601

  /**
   * Required when transitioning to `checked_out`. The
   * visitors_checkout_source_required CHECK constraint enforces this at
   * the DB layer; the service throws BadRequestException if it's missing
   * before the SQL ever runs.
   */
  checkout_source?: CheckoutSource;

  /**
   * Pass currently held by the visitor — used by the pass-return adapter
   * (slice 2b VisitorPassPoolService) on `checked_out`. Optional; visitors
   * without a physical pass have no pass to return.
   */
  visitor_pass_id?: string;
}

export interface TransitionStatusActor {
  user_id: string;
  person_id: string | null;
}
