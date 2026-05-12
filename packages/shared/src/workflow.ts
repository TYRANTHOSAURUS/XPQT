// Workflow node configuration constants shared between the engine
// (apps/api/src/modules/workflow) and the visual editor's inspector
// forms (apps/web/src/components/workflow-editor/inspector-forms).
// Single source of truth so the design-time editor's allowlist cannot
// drift from the runtime engine's allowlist.

/**
 * Fields the workflow `update_ticket` node may write. Mirrors the §3.0
 * `update_entity_combined` orchestrator's case-side branch surface
 * (status / priority / assignment / sla / metadata — plan branch is
 * WO-only and intentionally excluded since workflow_instances always
 * link to the parent case).
 *
 * The 19 orphan fields rejected by this allowlist (and the path-forward
 * for each if a workflow ever needs them) are documented in
 * `docs/follow-ups/b2-followups.md` under the "Workflow `update_ticket`
 * orphan fields" section.
 *
 * Engine partitions this list into per-branch buckets at the call site;
 * the editor uses the union for design-time validation only.
 */
export const UPDATE_TICKET_ALLOWED_FIELDS = [
  // status branch
  'status',
  'status_category',
  'waiting_reason',
  // priority branch
  'priority',
  // assignment branch
  'assigned_team_id',
  'assigned_user_id',
  'assigned_vendor_id',
  // sla branch
  'sla_id',
  // metadata branch
  'title',
  'description',
  'cost',
  'tags',
  'watchers',
] as const;

export type UpdateTicketAllowedField = (typeof UPDATE_TICKET_ALLOWED_FIELDS)[number];

export const UPDATE_TICKET_ALLOWED_FIELD_SET: ReadonlySet<string> = new Set(
  UPDATE_TICKET_ALLOWED_FIELDS,
);
