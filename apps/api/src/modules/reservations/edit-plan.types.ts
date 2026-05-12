/**
 * B.4 step 2D-C — TypeScript shape of the `EditPlan` jsonb the
 * `edit_booking` RPC consumes.
 *
 * Single source of truth for this shape:
 *   supabase/migrations/00364_edit_booking_rpc_v4.sql
 *     - top-level keys + validation: 00364:248-308
 *     - booking-patch required fields:                    00364:340-355
 *     - approval block (v4):                              00364:13-33 + :276-308
 *     - slot patch shape (consumed in 10.a):              00364:792-821
 *     - asset_reservation patch shape (10.c):             00364:842-851
 *     - order patch shape (10.d):                         00364:854-876
 *     - work-order patch shape (10.f):                    00364:930-944
 *     - sla.timer_repointed_required emit gate:           00364:1083-1103
 *
 * The RPC validates these shapes at the boundary; this TS interface is
 * the producer-side contract. Step 2D-D (TS editSlot cutover) will be
 * the first caller.
 *
 * NOTE on cost_amount_snapshot: NUMERIC(10,2) at storage, returned as
 * STRING from helpers (`computeCostFromHours`) to preserve precision
 * across the supabase-js boundary. The RPC casts via
 * `nullif(...,'')::numeric(10,2)` (00364:738) so empty-string and null
 * are coerced to NULL.
 */

/** Approver shape — re-exports the canonical type from the helpers
 * module to keep imports flat for plan consumers. */
export type EditPlanApprover = { type: 'person' | 'team'; id: string };

/** Approval-chain config consumed by §3.6.5 (00364:21-25 +
 * createApprovalRows at booking-flow.service.ts:1268). */
export interface EditPlanApprovalChainConfig {
  required_approvers: EditPlanApprover[];
  threshold: 'all' | 'any';
}

/** Approval block (v4) — REPLACES v3's `approval_outcome_changed` boolean.
 * Validated at 00364:276-308. */
export interface EditPlanApproval {
  /** 'allow' | 'require_approval' | 'deny' — outcome of the rule resolver
   * BEFORE the patch (i.e., on the current booking state). Drives the
   * §3.6.5 decision-table branch. */
  old_outcome: 'allow' | 'require_approval' | 'deny';
  /** 'allow' | 'require_approval' | 'deny' — outcome of the rule resolver
   * AFTER the patch (i.e., on the target state). 'deny' triggers Row 10
   * → RPC raises edit_booking.deny_on_edit (422). */
  new_outcome: 'allow' | 'require_approval' | 'deny';
  /** TS-computed boolean (spec §3.6.5 paragraph "Chain identity"): true
   * iff the canonical-sorted approver chain differs between old + new
   * outcomes. Drives Row 6 (preserve) vs Row 7/8 (expire + insert). */
  chain_config_changed: boolean;
  /** Required when an INSERT will happen (Rows 2/7/8). The RPC raises
   * edit_booking.invalid_plan_shape if absent on those rows
   * (00364:577-586). NULL otherwise. */
  new_chain_config: EditPlanApprovalChainConfig | null;
}

/** Booking-level patch (00364:340-355 enforces required keys). */
export interface EditPlanBookingPatch {
  /** REQUIRED. The target room (mirrors location_id on bookings — even
   * single-room edits set this so the RPC's audit diff is uniform). */
  location_id: string;
  /** REQUIRED. Booking-level start (typically MIN(slot.start_at)). ISO. */
  start_at: string;
  /** REQUIRED. Booking-level end (typically MAX(slot.end_at)). ISO. */
  end_at: string;
  /** REQUIRED. Cost snapshot string (NUMERIC(10,2) in storage). NULL when
   * the target room has no cost_per_hour. The RPC at 00364:352-354
   * REJECTS absence with `edit_booking.invalid_plan_shape`; the
   * KEY MUST BE PRESENT, value may be the literal `null`. (Codex 2026-05-12
   * IMPORTANT: prior `?` typed it as omittable, contradicting the RPC
   * contract.) Producers compute via `computeCostFromHours`; pass `null`
   * when the room has no `cost_per_hour`. */
  cost_amount_snapshot: string | null;

  // Optional preserve-or-overwrite fields (00364:740-778):
  policy_snapshot?: Record<string, unknown>;
  applied_rule_ids?: string[];
  cost_center_id?: string | null;
  calendar_etag?: string | null;
  host_person_id?: string | null;
  recurrence_overridden?: boolean;
  config_release_id?: string | null;
}

/** Per-slot patch (00364:792-821). slot_id identifies the row to update. */
export interface EditPlanSlotPatch {
  slot_id: string;
  space_id: string;
  start_at: string;
  end_at: string;
  setup_buffer_minutes?: number;
  teardown_buffer_minutes?: number;
  attendee_count?: number | null;
  attendee_person_ids?: string[];
}

/** Per-asset-reservation patch (00364:842-851). */
export interface EditPlanAssetReservationPatch {
  id: string;
  start_at: string;
  end_at: string;
}

/** Per-order patch (00364:854-876). */
export interface EditPlanOrderPatch {
  id: string;
  delivery_location_id?: string | null;
  requested_for_start_at?: string | null;
  requested_for_end_at?: string | null;
}

/** Per-work-order SLA patch (00364:930-944 + 1083-1103 emit gate).
 * `needs_repoint=true` triggers the sla.timer_repointed_required outbox
 * emit consumed by repoint_sla_timer_rpc (B.2.A). */
export interface EditPlanWorkOrderSlaPatch {
  id: string;
  planned_start_at: string;
  sla_due_at?: string | null;
  needs_repoint?: boolean;
  /** Carried for the outbox payload (00364:1093). */
  sla_policy_id?: string | null;
}

/**
 * The full EditPlan jsonb shape consumed by `edit_booking` RPC
 * (00364:248-308 enforces this at the SQL boundary).
 */
export interface EditPlan {
  booking: EditPlanBookingPatch;
  slot_patches: EditPlanSlotPatch[];
  asset_reservation_patches?: EditPlanAssetReservationPatch[];
  order_patches?: EditPlanOrderPatch[];
  work_order_sla_patches?: EditPlanWorkOrderSlaPatch[];
  /** ISO timestamp captured BEFORE the rule resolver ran. The RPC's
   * stale-resolution gate compares `room_booking_rules.updated_at` MAX
   * to this and raises automation_plan.stale_resolution if rules moved
   * since (00364:432-454). */
  _resolution_at: string;
  approval: EditPlanApproval;
}
