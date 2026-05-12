export interface TicketRequester {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  department: string;
}

export interface TicketLocation {
  id: string;
  name: string;
  type: string;
}

export interface TicketAsset {
  id: string;
  name: string;
  serial_number: string;
}

export interface TicketRequestType {
  id: string;
  name: string;
  domain: string;
}

export interface TicketDetail {
  id: string;
  ticket_kind: 'case' | 'work_order';
  // Per-tenant monotonic counter that drives the user-facing TKT-####
  // / WO-#### references. Allocated by tickets_assign_module_number()
  // on insert. This is NOT the dropped reservations.module_number
  // (00280) — that legacy column is gone for bookings; tickets keeps
  // the counter because the human-readable ref is load-bearing across
  // list rows, detail headers, command palette, email subjects, etc.
  // (formatTicketRef in lib/format-ref.ts).
  module_number: number;
  parent_ticket_id: string | null;
  title: string;
  description: string;
  status: string;
  status_category: string;
  priority: string;
  waiting_reason: string | null;
  interaction_mode: string;
  tags: string[];
  sla_id: string | null;
  sla_at_risk: boolean;
  sla_response_due_at: string | null;
  sla_resolution_due_at: string | null;
  sla_response_breached_at: string | null;
  sla_resolution_breached_at: string | null;
  planned_start_at: string | null;
  planned_duration_minutes: number | null;
  /**
   * Optimistic-lock version for work_orders (00382). Always 1+ on
   * work_order rows; undefined on case rows (the column lives on
   * work_orders only). Used by the detail-page PlanField to thread
   * plan_version on PATCHes that touch planning columns.
   */
  plan_version?: number;
  created_at: string;
  requester?: TicketRequester;
  location?: TicketLocation;
  asset?: TicketAsset;
  assigned_team?: { id: string; name: string };
  assigned_agent?: { id: string; email: string };
  request_type?: TicketRequestType;
  form_data?: Record<string, unknown> | null;
  cost?: number | null;
  watchers?: string[];
  assigned_vendor?: { id: string; name: string } | null;
  reclassified_at?: string | null;
  reclassified_reason?: string | null;
  reclassified_from_id?: string | null;
}

export interface TicketActivity {
  id: string;
  activity_type: string;
  visibility: string;
  content: string;
  attachments?: Array<{
    name: string;
    url?: string;
    path?: string;
    size: number;
    type: string;
  }>;
  author?: { first_name: string; last_name: string };
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/** Fields writable via PATCH /tickets/:id. */
export interface UpdateTicketPayload {
  title?: string;
  description?: string;
  status?: string;
  status_category?: string;
  waiting_reason?: string | null;
  priority?: string;
  assigned_team_id?: string | null;
  assigned_user_id?: string | null;
  assigned_vendor_id?: string | null;
  tags?: string[];
  watchers?: string[];
  cost?: number | null;
  sla_id?: string | null;
}

export type AssignmentKind = 'team' | 'user' | 'vendor';

export const ASSIGNMENT_FIELD: Record<AssignmentKind, keyof UpdateTicketPayload> = {
  team: 'assigned_team_id',
  user: 'assigned_user_id',
  vendor: 'assigned_vendor_id',
};

export interface ReassignVariables {
  kind: AssignmentKind;
  id: string | null;
  nextLabel: string | null;
  previousLabel: string | null;
  reason?: string;
  actorPersonId?: string;
}

/**
 * Fields writable via `PATCH /work-orders/:id`. Single-endpoint shape after
 * plan-reviewer P1 collapsed the per-field endpoints — see
 * `WorkOrderService.update` for the server-side dispatch. Every field is
 * optional; the server requires at least one to be present.
 */
export interface UpdateWorkOrderPayload {
  sla_id?: string | null;
  /** ISO timestamp, or null to clear the plan. Server clears
   *  `planned_duration_minutes` automatically when this is null. */
  planned_start_at?: string | null;
  planned_duration_minutes?: number | null;
  status?: string;
  status_category?: string;
  waiting_reason?: string | null;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  assigned_team_id?: string | null;
  assigned_user_id?: string | null;
  assigned_vendor_id?: string | null;
  // Slice 3.1 metadata fields. Match the case-side UpdateTicketPayload
  // shape: bulk metadata writes with no per-field side effects.
  title?: string;
  description?: string | null;
  cost?: number | null;
  tags?: string[] | null;
  watchers?: string[] | null;
  /**
   * Optimistic-lock token (00382). Set by planning-board gestures
   * (drag, resize, keyboard-nudge) AND the detail-page plan editor.
   * Compared server-side against the row's current plan_version when
   * the patch touches any of the trigger-tracked columns
   * (planned_start_at, planned_duration_minutes, assigned_team_id /
   * _user_id / _vendor_id). Mismatch → 409 planning.version_conflict.
   * Omit on patches that don't touch planning columns (status, sla,
   * priority, title) — the check is skipped.
   */
  plan_version?: number;
  /**
   * Audit-source provenance for the `plan_changed` activity row (00383
   * v6). Three accepted values:
   *  - `'board'` — drag, resize, or keyboard nudge on /desk/planning.
   *  - `'detail'` — PlanField popover on the ticket detail panel.
   *  - `'generator'` — reserved for the Slice C PM generator producer.
   *
   * Stamped into `ticket_activities.metadata.source` only when the
   * plan branch fires. Omit on patches that don't touch the plan
   * (sla / status / priority / metadata) — the RPC ignores it. The
   * server validates the enum at both the controller and RPC layers.
   */
  _source?: 'board' | 'detail' | 'generator';
}
