/**
 * Typed outbox event-type constants for the approval lifecycle (Phase 1.5
 * sub-step 6.C).
 *
 * Convention matches the booking-edit / vendor-portal / daily-list /
 * privacy-compliance pattern (`<domain>.<verb>`). Producer-side typed
 * constants for typo safety; handlers register against the same string
 * literals on the consumer side.
 *
 * Emission pattern: the `approval.granted` event is emitted from inside the
 * `grant_booking_approval` v2 PL/pgSQL body (migration 00403) via
 * `perform outbox.emit(...)`, ONLY on the `kind='resolved'` branch + when
 * the approval row has a populated `workflow_instance_id` (Phase 1.5
 * workflow-driven approvals; legacy createApprovalRows paths skip the emit
 * and rely on the existing TS-side `onApprovalDecided` fan-out at
 * approval.service.ts:847).
 *
 * Spec: docs/superpowers/specs/phase-1.5-visual-approval-workflow-plan.md
 *   §2.6.4 (lines 481-484) — event-type registration site.
 *   §6.C (lines 1260) — file location.
 *
 * Until WorkflowApprovalGrantedHandler (sub-step 6.D) registers, emits
 * will dead-letter with `no_handler_registered` — that's the intended
 * behaviour during the migration window. v1 dead-lettering means the
 * resolved booking still transitions (the RPC body's domain_events insert
 * + slot/booking UPDATE all commit), just no downstream workflow resume()
 * fires. Once 6.D ships the handler, the resume() path is wired.
 */
export const ApprovalLifecycleEventType = {
  /**
   * Approval chain resolved (all-of-N satisfied OR any-of-N's first
   * 'approved' OR a 'rejected' on any threshold).
   *
   * Payload (from migration 00403's outbox.emit call):
   * ```
   * {
   *   tenant_id: uuid;
   *   approval_id: uuid;
   *   booking_id: uuid;
   *   final_decision: 'approved' | 'rejected';
   *   workflow_instance_id: uuid;     // non-null on Phase 1.5 emits
   *   workflow_node_id: text | null;  // approval node id within the graph
   * }
   * ```
   *
   * Handler: `WorkflowApprovalGrantedHandler` (sub-step 6.D) calls
   * `WorkflowEngineService.resume(workflow_instance_id, tenant_id,
   * final_decision)` — resume() handles idempotency via its atomic claim.
   *
   * Note: the LEGACY `onApprovalDecided` TS fan-out at
   * approval.service.ts:847 stays for non-workflow-driven approvals
   * (where workflow_instance_id is NULL). One concrete surface per
   * approval — the RPC's emit only fires when workflow_instance_id is
   * populated, so the two paths don't double-fire.
   */
  Granted: 'approval.granted',
} as const;

export type ApprovalLifecycleEventTypeT =
  (typeof ApprovalLifecycleEventType)[keyof typeof ApprovalLifecycleEventType];

/**
 * Payload contract for {@link ApprovalLifecycleEventType.Granted}. Mirrors
 * the jsonb produced by migration 00403's `perform outbox.emit(...)` call.
 * Optional fields are JSONB-nullable per the producer.
 */
export interface ApprovalLifecyclePayload {
  tenant_id: string;
  approval_id: string;
  booking_id: string;
  final_decision: 'approved' | 'rejected';
  workflow_instance_id: string;
  workflow_node_id: string | null;
}
