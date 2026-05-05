/**
 * AttachPlan — TS plan-builder shape for the combined `create_booking_with_attach_plan`
 * RPC (B.0.A migration on remote). Spec: §7.4 of
 * docs/superpowers/specs/2026-05-04-domain-outbox-design.md.
 *
 * Every UUID in the plan is pre-generated TS-side via `planUuid()` so a TS
 * retry of the same logical request rebuilds an identical plan, hashes
 * identically, and hits the `attach_operations.cached_result` fast-path.
 *
 * The shape is serialised verbatim as jsonb arguments to the RPC. Field
 * names mirror the SQL CREATE TABLE columns and the RPC parameter list at
 * supabase/migrations/00303_create_booking_with_attach_plan_rpc.sql so the
 * RPC body can pull values without per-column rename discipline.
 */

/**
 * BookingInput — the booking + slot rows. Mirrors `create_booking` RPC at
 * 00277:236-292 plus the booking-id pre-generation discipline introduced
 * in v6 (§7.4).
 */
export interface BookingInput {
  /** = planUuid(key, 'booking', '0'). Inserted verbatim by the RPC. */
  booking_id: string;
  /** Mirrors slots[].id — kept top-level for the §7.4 enumeration table. */
  slot_ids: string[];

  // Booking-row columns
  requester_person_id: string;
  host_person_id: string | null;
  booked_by_user_id: string | null;
  location_id: string;
  start_at: string;
  end_at: string;
  timezone: string;
  status: 'draft' | 'pending_approval' | 'confirmed';
  source: 'portal' | 'desk' | 'api' | 'calendar_sync' | 'reception' | 'recurrence';
  title: string | null;
  description: string | null;
  cost_center_id: string | null;
  /** Numeric serialised as string (matches `bookings.cost_amount_snapshot::numeric`). */
  cost_amount_snapshot: string | null;
  policy_snapshot: Record<string, unknown>;
  applied_rule_ids: string[];
  config_release_id: string | null;
  recurrence_series_id: string | null;
  recurrence_index: number | null;
  template_id: string | null;

  /**
   * Slots — one per resource being held (single-room = 1, multi-room = N).
   * Mirrors `booking_slots` columns (00277:116-160).
   */
  slots: AttachPlanBookingSlot[];
}

export interface AttachPlanBookingSlot {
  /** = planUuid(key, 'slot', String(display_order)). Matches BookingInput.slot_ids[i]. */
  id: string;
  slot_type: 'room' | 'desk' | 'asset' | 'parking';
  space_id: string;
  start_at: string;
  end_at: string;
  attendee_count: number | null;
  attendee_person_ids: string[];
  setup_buffer_minutes: number;
  teardown_buffer_minutes: number;
  check_in_required: boolean;
  check_in_grace_minutes: number;
  display_order: number;
}

/**
 * AttachPlan — service attachment side of the combined RPC. The booking
 * may have zero services (e.g. plain room booking) — in that case the plan
 * still ships with empty arrays + `any_pending_approval=false` + `any_deny=false`.
 */
export interface AttachPlan {
  /** Bumped on shape change. Currently always 1. */
  version: 1;
  /**
   * Pre-computed by the plan-builder so the RPC can decide whether to skip
   * setup-WO emission without re-inspecting outcomes.
   */
  any_pending_approval: boolean;
  /** When true, RPC raises `service_rule_deny` before any insert. */
  any_deny: boolean;
  /** Joined for the error payload when `any_deny=true`. */
  deny_messages: string[];

  orders: AttachPlanOrder[];
  asset_reservations: AttachPlanAssetReservation[];
  order_line_items: AttachPlanOrderLineItem[];
  approvals: AttachPlanApproval[];
  bundle_audit_payload: BundleAuditPayload;
}

/**
 * Orders — one per service_type group. The stableIndex IS the service_type
 * (one order per service_type by construction); see §7.4 row-kind table.
 */
export interface AttachPlanOrder {
  /** = planUuid(key, 'order', service_type). */
  id: string;
  service_type: string;
  requester_person_id: string;
  delivery_location_id: string;
  delivery_date: string;
  requested_for_start_at: string;
  requested_for_end_at: string;
  /** Computed from `any_pending_approval`. */
  initial_status: 'submitted' | 'approved';
  policy_snapshot: { service_type: string };
}

/**
 * AssetReservations — one per OLI that linked an asset. The stableIndex
 * is the OLI's `client_line_id` (1:1 with the OLI; OLI is sorted by
 * `client_line_id`).
 */
export interface AttachPlanAssetReservation {
  /** = planUuid(key, 'asset_reservation', `${order_id}:${client_line_id}`). */
  id: string;
  asset_id: string;
  start_at: string;
  end_at: string;
  requester_person_id: string;
  /** = booking_input.booking_id. */
  booking_id: string;
  /** Always 'confirmed' from the plan. */
  status: 'confirmed';
}

/**
 * Order line items. `client_line_id` is REQUIRED on every input line in
 * v8 — the plan-builder validates presence + per-order uniqueness and
 * rejects requests without it. Spec §7.4 + §7.4 v8 stable-index table.
 */
export interface AttachPlanOrderLineItem {
  /** = planUuid(key, 'oli', `${order_id}:${client_line_id}`). */
  id: string;
  /**
   * REQUIRED in v8. Caller-supplied stable identifier for this line within
   * the request. Typically the React form-row key or a hash of
   * (catalog_item_id, service_window). Plan-builder rejects requests where
   * any line is missing this OR where two lines in the same order have
   * the same value.
   */
  client_line_id: string;
  /** FK into AttachPlan.orders[].id. */
  order_id: string;
  catalog_item_id: string;
  quantity: number;
  unit_price: number | null;
  line_total: number | null;
  fulfillment_status: 'ordered';
  fulfillment_team_id: string | null;
  vendor_id: string | null;
  menu_item_id: string | null;
  linked_asset_id: string | null;
  /** FK into AttachPlan.asset_reservations[].id. */
  linked_asset_reservation_id: string | null;
  service_window_start_at: string;
  service_window_end_at: string;
  repeats_with_series: boolean;
  /**
   * Persisted on the OLI when `any_pending_approval=true` so
   * `approve_booking_setup_trigger` can re-emit the snapshot on grant
   * without re-resolving rules. NULL when the line doesn't require
   * internal setup.
   */
  pending_setup_trigger_args: Record<string, unknown> | null;
  policy_snapshot: {
    menu_id: string | null;
    menu_item_id: string | null;
    unit: 'per_item' | 'per_person' | 'flat_rate' | null;
    service_type: string;
  };
  /**
   * Setup-WO emit hint. Only present when the line's rule outcome
   * `requires_internal_setup=true` AND `any_pending_approval=false`. The
   * RPC reads this to construct the `setup_work_order.create_required`
   * outbox event. Plan-builder MUST omit this hint on pending-approval
   * lines (the RPC has a defense-in-depth gate; see §7.6 step 12).
   */
  setup_emit: AttachPlanSetupEmit | null;
}

export interface AttachPlanSetupEmit {
  service_category: string;
  rule_ids: string[];
  lead_time_override_minutes: number | null;
}

/**
 * Approvals — pre-deduped + pre-merged by `ApprovalRoutingService.assemblePlan`.
 * One row per `approver_person_id` after dedup. In v6+ the stableIndex IS
 * the `approver_person_id`.
 *
 * Note: `target_entity_type` is canonicalised to 'booking' for the combined
 * RPC (00278:172). The wider TS union `'booking' | 'order'` lives on
 * `AssembleApprovalsArgs` for the standalone-order path.
 */
export interface AttachPlanApproval {
  /** = planUuid(key, 'approval', approver_person_id). */
  id: string;
  target_entity_type: 'booking';
  /** = booking_input.booking_id. */
  target_entity_id: string;
  approver_person_id: string;
  scope_breakdown: AttachPlanApprovalScopeBreakdown;
  status: 'pending';
}

export interface AttachPlanApprovalScopeBreakdown {
  /** Legacy field name; values are booking ids post-canonicalisation. */
  reservation_ids: string[];
  order_ids: string[];
  order_line_item_ids: string[];
  ticket_ids: string[];
  asset_reservation_ids: string[];
  reasons: Array<{ rule_id: string; denial_message: string | null }>;
}

/**
 * Audit-row meta for the `bundle.created` event_type
 * (bundle.service.ts:464-472). Returned by the RPC alongside the inserted
 * ids so callers can construct an audit row without re-reading.
 */
export interface BundleAuditPayload {
  /** = booking_input.booking_id. */
  bundle_id: string;
  /** = booking_input.booking_id. */
  booking_id: string;
  order_ids: string[];
  order_line_item_ids: string[];
  asset_reservation_ids: string[];
  approval_ids: string[];
  any_pending_approval: boolean;
}

/**
 * RPC return shape (via `supabase.admin.rpc`). The RPC builds this server-side
 * from the plan + the inserted ids. Mirrors §7.6 step 13.
 */
export interface CreateBookingWithAttachPlanResult {
  booking_id: string;
  slot_ids: string[];
  order_ids: string[];
  order_line_item_ids: string[];
  asset_reservation_ids: string[];
  approval_ids: string[];
  any_pending_approval: boolean;
}
