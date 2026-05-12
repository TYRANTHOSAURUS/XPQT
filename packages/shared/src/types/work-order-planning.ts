/**
 * Wire types for the planning-board read path (`GET /work-orders/planning`).
 * Shared with the frontend so the planning page renders against the same
 * shape the API produces — no DTO drift between desk and server.
 */

import type { StatusCategory } from './enums';

/**
 * The lane a planning block belongs to. Typed discriminator so users,
 * teams, and vendors stay in separate namespaces (their UUIDs occupy
 * different tables; a bare uuid collision would silently fail).
 *
 * `unassigned` represents work_orders with no team/user/vendor on the
 * assignment columns at all — they render in a sticky-top lane so the
 * dispatcher can drag them onto a real assignee.
 */
export type PlanningLaneKind = 'user' | 'team' | 'vendor' | 'unassigned';

export interface PlanningLaneId {
  kind: PlanningLaneKind;
  id: string | null; // null only when kind === 'unassigned'
  /** Display label rendered as the lane header. Resolved server-side so the FE doesn't second-fetch user/team/vendor rows. */
  label: string;
}

/**
 * One renderable block on the planning grid (or in the unscheduled rail).
 *
 * `can_plan` is precomputed server-side per block so the FE can hide
 * drag handles without a per-block round-trip — the can-plan logic
 * matches the existing `assertCanPlan` gate.
 */
export interface WorkOrderPlanningBlock {
  id: string;
  module_number: number;            // drives the WO-#### ref via formatTicketRef
  title: string;
  status_category: StatusCategory;
  priority: 'low' | 'medium' | 'high' | 'critical';
  planned_start_at: string | null;  // null in unscheduled[]
  planned_duration_minutes: number | null;
  sla_resolution_due_at: string | null;
  lane: PlanningLaneId;
  request_type: { id: string; name: string; domain: string } | null;
  can_plan: boolean;
  /**
   * Optimistic-lock version (00382). The FE stages every plan-touching
   * PATCH with the version it read on the block. If a concurrent
   * dispatcher's PATCH lands first the row's plan_version bumps; the
   * loser's PATCH returns 409 `planning.version_conflict` with the
   * row's current version in `serverVersion`. The FE rolls back the
   * optimistic patch and prompts "Reload" or "Keep mine".
   */
  plan_version: number;
}

export interface WorkOrderPlanningResponse {
  /** Blocks with `planned_start_at` falling inside [from, to). */
  planned: WorkOrderPlanningBlock[];
  /** Blocks with `planned_start_at IS NULL` matching the same filters (status, team). */
  unscheduled: WorkOrderPlanningBlock[];
  /**
   * Lanes the dispatcher can drop onto. When a `team_id` filter is set,
   * the server returns the full team roster (members + active vendor
   * assignees) — so an idle assignee with zero blocks still appears as a
   * drop target. With no `team_id` filter, only lanes that hold at least
   * one block are returned to avoid all-teams explosions.
   *
   * Pre-sorted: unassigned first, then alphabetical by `label`, with kind
   * (user → team → vendor) as the tiebreaker. The FE renders in this
   * order without re-sorting.
   */
  lanes: PlanningLaneId[];
  /**
   * True when the lane derivation hit the 50-lane cap and the result is
   * the most-active subset. Drives a one-time warning toast on the
   * planning page so the dispatcher knows the roster is partial.
   */
  truncated?: boolean;
}

/** Server-side cap on the number of lanes returned in a single window. */
export const PLANNING_LANES_MAX = 50;

/**
 * Server-side cap on the visible window. Set conservatively so the planning
 * board can't accidentally load thousands of rows; tune up if real usage
 * proves the limit too tight.
 */
export const PLANNING_WINDOW_MAX_DAYS = 14;
