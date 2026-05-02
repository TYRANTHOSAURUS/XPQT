/**
 * Wire shape for the rail-badge count endpoints. See spec
 * docs/superpowers/specs/2026-05-02-main-menu-redesign-design.md §Counts.
 *
 * `hasUrgency` is computed server-side per the rules in the spec; the rail
 * renders a binary red dot when true (no semantic distinction between the
 * various urgency causes — that lives in the per-item screens).
 */
export interface NavCount {
  count: number;
  hasUrgency: boolean;
}
