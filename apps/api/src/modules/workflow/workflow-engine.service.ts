import { randomUUID } from 'node:crypto';
import { Inject, Injectable, forwardRef } from '@nestjs/common';
import {
  buildWorkflowAssignmentIdempotencyKey,
  buildWorkflowUpdateTicketIdempotencyKey,
  UPDATE_TICKET_ALLOWED_FIELD_SET,
  type KnownErrorCode,
} from '@prequest/shared';
import { AppError, AppErrors, mapRpcErrorToAppError } from '../../common/errors';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { assertTenantOwned } from '../../common/tenant-validation';
import { DispatchService } from '../ticket/dispatch.service';
import { SlaService } from '../sla/sla.service';

// B.2.A.Step9 — workflow `update_ticket` node allowlist (option 2).
//
// Pre-Step 9, the engine accepted a 29-field surface (20 "safe scalar"
// + 9 FK) and wrote directly to `tickets`. That surface drifted away
// from the §3.0 `update_entity_combined` orchestrator (00335 v5) which
// only branches on a narrow set of patches. Step 9 cuts the engine
// over to the orchestrator and tightens the allowlist to the 14
// fields the orchestrator actually handles — anything else is rejected
// with `workflow.update_ticket_field_not_allowed`.
//
// Why fail loud (not silent drop): a silently-dropped field hides a
// workflow-author bug. Throwing at execution time surfaces it on the
// audit feed for ops triage and forces the author to either remove
// the orphan field or push an orchestrator branch extension up to
// Product. Per `project_no_wave1_yet` memory (no production tenant
// depends on these workflows), risk-free in customer terms.
//
// The 17 orphan fields and their phased remediation are documented in
// `docs/follow-ups/b2-followups.md` (new "workflow update_ticket
// orphan fields" entry under §3.0 Step 9 closeout).
//
// Doc-drift trigger: this allowlist is the contract for what a workflow
// can write. When the §3.0 orchestrator extends its branches, decide
// whether a new field belongs here, and update
// `docs/assignments-routing-fulfillment.md` (§Workflow engine writes).

/**
 * The 14 fields the §3.0 `update_entity_combined` orchestrator accepts.
 *
 * Branch citations (orchestrator's six branches):
 *   - status:     00335:159-160 (status / status_category / waiting_reason)
 *   - priority:   00335:163     (priority)
 *   - assignment: 00335:161     (assigned_team_id / _user_id / _vendor_id)
 *   - sla:        00335:162     (sla_id; timers built TS-side)
 *   - plan:       00335:164     — WO-only on `update_entity_combined`
 *                                (00335:170-173 rejects `entity_kind='case'`
 *                                + plan with `plan_not_supported_on_case`).
 *                                Workflow `update_ticket` nodes ALWAYS
 *                                target the parent case, so plan fields
 *                                are categorically misconfigured on this
 *                                surface — rejected via
 *                                `workflow.update_ticket_field_not_allowed`
 *                                here rather than the downstream
 *                                `plan_not_supported_on_case` raise.
 *   - metadata:   00335:165     (title / description / cost / tags / watchers)
 *
 * The granular per-branch sets (status/priority/assignment/sla/metadata)
 * used to be declared here but were dead — only the union below is
 * referenced. Imported from `@prequest/shared` so the visual editor's
 * design-time validation uses the same source of truth as this runtime
 * check.
 */
const UPDATE_TICKET_ALLOWED_FIELDS = UPDATE_TICKET_ALLOWED_FIELD_SET;

/**
 * Phase 1.B (universal workflow architecture). The engine talks to three
 * primary entity kinds polymorphically; this union is the canonical surface
 * shape exported alongside the service.
 *
 * Spec: docs/superpowers/specs/2026-05-12-universal-workflow-architecture-design.md §3.1, §3.6.
 */
export type WorkflowEntityKind = 'case' | 'work_order' | 'booking';

/** Depth limit for spawn-link chain walks. Locked at 10 per spec §3.6. */
const SPAWN_LINK_DEPTH_LIMIT = 10;

/**
 * Map a polymorphic entity kind to the matching `<kind>_id` column on
 * `workflow_instances`. The columns ship from migration 00369:
 *   - `case_id` (was `ticket_id`; renamed per the post-00238 contract)
 *   - `work_order_id`
 *   - `booking_id` (added 00369:231-233)
 *
 * Each polymorphic row has exactly one of these set non-null, enforced by
 * the `validate_workflow_instance_polymorphism` trigger (00369:399-418).
 */
function polymorphicIdColumn(kind: WorkflowEntityKind): 'case_id' | 'work_order_id' | 'booking_id' {
  switch (kind) {
    case 'case':       return 'case_id';
    case 'work_order': return 'work_order_id';
    case 'booking':    return 'booking_id';
  }
}

interface WorkflowNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
}

interface WorkflowEdge {
  from: string;
  to: string;
  condition?: string;
}

interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface EmittedEvent {
  event_type: string;
  node_id?: string;
  node_type?: string;
  decision?: string;
  payload?: Record<string, unknown>;
}

export interface WorkflowRunContext {
  dryRun: boolean;
  simulatedTicket?: Record<string, unknown>;
  events: EmittedEvent[];
  path: string[];
  stoppedAt?: { node_id: string; node_type: string; reason: string };
}

@Injectable()
export class WorkflowEngineService {
  constructor(
    private readonly supabase: SupabaseService,
    @Inject(forwardRef(() => DispatchService)) private readonly dispatchService: DispatchService,
    // B.2.A.Step9 — `update_ticket` node's sla branch needs pre-computed
    // timer due_at values (business-hours-adjusted) before calling
    // `update_entity_combined`. Mirrors `WorkOrderService` injection
    // pattern at apps/api/src/modules/work-orders/work-order.service.ts
    // (sla branch at :469-480 calls the same helper).
    private readonly slaService: SlaService,
  ) {}

  /**
   * Project the polymorphic entity_kind to its legacy audit literal.
   *
   * Case-kind workflows EMIT `'ticket'` for `related_entity_type` /
   * `target_entity_type` because ApprovalService.respond
   * (apps/api/src/modules/approval/approval.service.ts:532) discriminates
   * on the literal `'ticket'` to route to the §3.5 grant_ticket_approval
   * RPC. Booking + work_order emit their kind directly — no consumer
   * regression because those paths are new in Phase 1.A/1.B.
   *
   * Spec: docs/superpowers/specs/2026-05-12-universal-workflow-architecture-design.md §3.6 (Phase 1 polymorphization).
   */
  private projectLegacyEntityType(kind: WorkflowEntityKind): string {
    return kind === 'case' ? 'ticket' : kind;
  }

  /**
   * Phase 1.5 sub-step 6.A — read the polymorphic (entity_kind, entityId) pair
   * off a `workflow_instances` row. Used by the `approval` executor to write
   * the right (target_entity_type, target_entity_id) pair on each
   * `approvals` row instance, replacing the legacy `entityKind='case'` +
   * `ticketId` hardcode.
   *
   * `case_id` is preferred over `ticket_id` when entity_kind='case' —
   * `case_id` is the post-00238 contract column; `ticket_id` is the legacy
   * NULL-able column kept for backward compat (workflow_instances rows from
   * before 00369 may still carry the value there).
   *
   * Tenant-filtered via the ambient `TenantContext` — same guard shape as
   * every other admin read in this service. Throws
   * `workflow.advance_failed` if the row is missing OR the polymorphic
   * entityId is null on a row we found (shouldn't happen given the
   * validate_workflow_instance_polymorphism trigger at 00369:399-418, but
   * defensive — booking_id is ON DELETE SET NULL so a booking row deleted
   * out from under an active workflow_instance is reachable).
   *
   * Spec: docs/superpowers/specs/phase-1.5-visual-approval-workflow-plan.md §2.4 + §3.3.
   */
  async getEntityKindForInstance(
    instanceId: string,
  ): Promise<{ kind: WorkflowEntityKind; entityId: string }> {
    const tenant = TenantContext.current();
    const { data } = await this.supabase.admin
      .from('workflow_instances')
      .select('entity_kind, case_id, work_order_id, booking_id, ticket_id')
      .eq('id', instanceId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (!data) {
      throw AppErrors.server('workflow.advance_failed', {
        detail: `workflow_instance ${instanceId} not found in tenant ${tenant.id}`,
      });
    }
    const row = data as {
      entity_kind: WorkflowEntityKind | null;
      case_id: string | null;
      work_order_id: string | null;
      booking_id: string | null;
      ticket_id: string | null;
    };
    const kind: WorkflowEntityKind = row.entity_kind ?? 'case';
    let entityId: string | null;
    if (kind === 'case') {
      // Prefer case_id (post-00238 contract); fall back to ticket_id for
      // legacy rows that pre-date 00369.
      entityId = row.case_id ?? row.ticket_id;
    } else if (kind === 'work_order') {
      entityId = row.work_order_id;
    } else {
      entityId = row.booking_id;
    }
    if (!entityId) {
      throw AppErrors.server('workflow.advance_failed', {
        detail: `missing polymorphic entityId for instance ${instanceId} (kind=${kind})`,
      });
    }
    return { kind, entityId };
  }

  /**
   * Cancel any active workflow_instance for a `(entity_kind, entity_id)`
   * pair, then cascade through `workflow_instance_links` to resolve any
   * spawned children per the link's `on_parent_cancel` policy.
   *
   * Idempotent: safe to call when no active instance exists (no-op).
   *
   * Spec: docs/superpowers/specs/2026-05-12-universal-workflow-architecture-design.md §3.6
   * (Cancellation propagation — full design).
   *
   * ── Cascade order (CRITICAL fold-in from self-review) ───────────────
   *
   * For each link with `on_parent_cancel='cancel_child'`:
   *   1. Cancel the spawned ENTITY first.
   *   2. THEN recursively cancel the child workflow_instance.
   *   3. ONLY THEN resolve the link row.
   *
   * The previous order (resolve link → then cancel entity) led to the
   * "link claims parent_cancelled but booking still alive" inconsistency
   * — a partial-failure on entity-cancel left the link permanently
   * marked resolved while the booking was still on the calendar. The
   * new order keeps the link OPEN when entity-cancel fails or is
   * deferred, so ops can finish the work.
   *
   * ── Visited-set defense ─────────────────────────────────────────────
   *
   * Defensive: `checkSpawnLinkSafety` prevents cycles at SPAWN time
   * (cycle_detected/422). The cascade itself is a different code path
   * — if a link row was already corrupt at cascade time (e.g. created
   * before the safety check shipped), the visited-set short-circuits
   * an infinite recursion. The set is keyed by **instance_id** (unique
   * per workflow_instance row) so cascades into a child workflow whose
   * driving entity has already been deleted (booking_id SET NULL after
   * delete_booking_with_guard succeeds — 00369:231-233) still get
   * uniquely identified.
   *
   * @param entityKind        Primary kind of the entity whose workflow we're cancelling.
   * @param entityId          UUID of the entity row.
   * @param tenantId          Tenant scope; passed explicitly per the project's
   *                          tenant_id-as-#0-invariant rule.
   * @param reason            Free-form text recorded on the workflow_instance +
   *                          on the `instance_cancelled` audit event.
   * @param cascadeContext    Set when called recursively from a parent cascade;
   *                          carries the triggering link id + parent instance id
   *                          for audit-trail visualisation.
   * @param visitedSet        Internal recursion guard. Caller passes undefined;
   *                          recursive calls inherit the accumulated set.
   */
  async cancelInstance(
    entityKind: WorkflowEntityKind,
    entityId: string,
    tenantId: string,
    reason: string,
    cascadeContext?: {
      triggeredByLinkId: string;
      parentInstanceId: string;
    },
    visitedSet?: Set<string>,
  ): Promise<void> {
    const idColumn = polymorphicIdColumn(entityKind);

    // Locate the active instance for this (kind, id, tenant). If none,
    // no-op — nothing to cancel.
    //
    // NOTE: this entity-FK lookup is the FIRST-LEVEL path (caller knows
    // the entity but not the instance id). For cascaded calls — where
    // we DO know the child_instance_id from workflow_instance_links —
    // the cascade uses `cancelInstanceById` directly, bypassing this
    // lookup. That's critical for booking children whose row gets
    // deleted by delete_booking_with_guard, since
    // `workflow_instances.booking_id` is `ON DELETE SET NULL`
    // (00369:231-233) — the entity-FK lookup would return zero rows
    // for an orphaned-but-still-active workflow_instance.
    const { data: lookup } = await this.supabase.admin
      .from('workflow_instances')
      .select('id')
      .eq('entity_kind', entityKind)
      .eq(idColumn, entityId)
      .eq('tenant_id', tenantId)
      .in('status', ['active', 'waiting'])
      .limit(1)
      .maybeSingle();

    if (!lookup) {
      return;
    }
    const instanceId = (lookup as { id: string }).id;

    return this.cancelInstanceById(
      instanceId,
      tenantId,
      reason,
      cascadeContext,
      visitedSet,
      { entityKind, entityId },
    );
  }

  /**
   * Internal cancel-by-instance-id. Distinct from `cancelInstance` so
   * the recursive cascade can pass the already-known `child_instance_id`
   * directly — without going back through the polymorphic FK lookup
   * (which would return zero rows for a booking whose row was just
   * deleted, since `workflow_instances.booking_id` is ON DELETE SET NULL
   * — 00369:231-233).
   *
   * Visited-set key is `instanceId` (unique per workflow_instance row),
   * not `(entity_kind, entity_id)` — the latter is ambiguous for
   * cascaded calls into booking-children whose entity row is gone.
   *
   * `entityHint` is set when the caller already knows (entity_kind,
   * entity_id) — `cancelInstance` resolved them from its own params
   * before calling here. Recursive cascade calls don't carry the hint:
   * the link row only has the child's entity descriptor, and the
   * recursive call needs to read the actual instance row to get the
   * true entity_kind off the row (since for a booking-child whose row
   * was deleted, the link still names `child_entity_kind='booking'` +
   * `child_entity_id=<bookingId>`, but the workflow_instance row has
   * `booking_id=NULL` after the FK SET NULL — entity_kind survives).
   */
  private async cancelInstanceById(
    instanceId: string,
    tenantId: string,
    reason: string,
    cascadeContext?: {
      triggeredByLinkId: string;
      parentInstanceId: string;
    },
    visitedSet?: Set<string>,
    entityHint?: { entityKind: WorkflowEntityKind; entityId: string },
  ): Promise<void> {
    const visited = visitedSet ?? new Set<string>();
    if (visited.has(instanceId)) {
      // Defensive: spawn-time cycle check (assertSpawnLinkSafe) should
      // make this unreachable, but a corrupt link from before that check
      // shipped could trigger it. Log + return rather than infinite-loop.
      console.warn('[workflow] cancelInstance: visited-set short-circuit', {
        instanceId,
        cascadeContext,
      });
      return;
    }
    visited.add(instanceId);

    // Phase 1.5 sub-step 6.A, Change 4 (CRITICAL 4 closure):
    // Atomic claim + approvals expiry + audit emit via the
    // `cancel_workflow_instance_with_approvals` RPC (migration 00400).
    //
    // Before Phase 1.5 this was a TS-side UPDATE + emit pair preceded by
    // an entity-descriptor lookup so the audit payload could carry
    // entity_kind + entity_id. With the RPC owning the atomic claim it
    // also owns the audit emit AND the entity_kind/entity_id lookup
    // (CTE RETURNING + coalesce), so the TS-side resolution is now dead.
    // The `entityHint` parameter is no longer load-bearing; the upstream
    // caller (cancelInstance) still passes it for backward compat but the
    // RPC ignores it.
    //
    // cascadeContext (triggered_by_link_id + parent_instance_id) is NOT
    // threaded into the RPC payload. The link audit chain at
    // `resolveLinkRow` (line ~660 below) still emits `link_resolved` /
    // `link_pending_entity_cancel` events that name the link id, so the
    // cascade chain is reconstructible without duplicating it on the
    // cancel event. Acceptable tradeoff for atomicity.
    //
    // The link cascade enumeration at line ~480 STAYS TS-side — it's
    // idempotent + has per-link error boundaries that don't need atomicity.
    const { data: rpcRows, error: rpcErr } = await this.supabase.admin.rpc(
      'cancel_workflow_instance_with_approvals',
      {
        p_instance_id: instanceId,
        p_tenant_id: tenantId,
        p_reason: reason,
      },
    );
    if (rpcErr) {
      throw AppErrors.server('workflow.cancel_with_approvals_failed', {
        detail: `RPC failed: ${rpcErr.message}`,
      });
    }
    const rpcRow = (rpcRows ?? [])[0] as
      | { claimed: boolean; approvals_expired_ct: number }
      | undefined;
    if (!rpcRow?.claimed) {
      // Lost the race — another worker cancelled. RPC's atomic claim returned
      // 0 rows. They emit the audit event; we no-op.
      return;
    }

    // entityHint is unused now that the RPC owns the entity resolution.
    // Keeping the parameter on the signature for backward compat with the
    // `cancelInstance` caller path that already computes + passes it; the
    // refactor to remove it from the signature is a follow-up.
    void entityHint;
    void cascadeContext;

    // Step 4: cascade through workflow_instance_links. Tenant-filtered
    // (admin client bypasses RLS). Process every link individually with
    // try/catch boundaries so one bad link doesn't abort the loop.
    //
    // Codex BLOCKER remediation (2026-05-12 Phase 1.C): the SELECT used to
    // filter `.is('resolved_at', null)`. That filter caused a child-
    // cancellation leak when the Tier 1 cron sweeper claimed a link
    // (setting resolved_at=now(), resolution_kind='timeout') between this
    // cancelInstance call's atomic claim of `parent.status='cancelled'` and
    // this enumeration. The cron-claimed link disappeared from the
    // enumeration, the child entity + child workflow_instance stayed
    // alive forever, and cron's subsequent engine.resume() no-op'd because
    // parent.status was no longer 'waiting'.
    //
    // Fix: enumerate ALL links from this parent regardless of resolved_at.
    // The semantic work (cancel child entity + cancel child workflow) runs
    // UNCONDITIONALLY. resolveLinkRow is the only step that's conditional
    // on resolved_at — its UPDATE keeps the `.is('resolved_at', null)`
    // guard so the link's audit-only resolution_kind isn't overwritten
    // (and a duplicate `link_resolved` isn't emitted). The link's
    // resolution_kind is audit-only; what matters is the child cascade.
    const { data: linkRows } = await this.supabase.admin
      .from('workflow_instance_links')
      .select(
        'id, child_instance_id, child_entity_kind, child_entity_id, on_parent_cancel',
      )
      .eq('parent_instance_id', instanceId)
      .eq('tenant_id', tenantId);

    const links = (linkRows ?? []) as Array<{
      id: string;
      child_instance_id: string | null;
      child_entity_kind: WorkflowEntityKind;
      child_entity_id: string;
      on_parent_cancel: 'cancel_child' | 'orphan_child';
    }>;

    for (const link of links) {
      try {
        if (link.on_parent_cancel === 'orphan_child') {
          await this.resolveLinkRow(
            link.id,
            instanceId,
            link.child_entity_kind,
            link.child_entity_id,
            tenantId,
          );
          continue;
        }

        // cancel_child: order matters — entity first, child workflow
        // second, link third. See the method header for the full
        // rationale.
        let entityCancelOk = false;
        let entityCancelDeferred = false;

        if (link.child_entity_kind === 'booking') {
          const outcome = await this.tryCancelBookingForCascade(
            link.id,
            instanceId,
            link.child_entity_id,
            tenantId,
          );
          entityCancelOk = outcome === 'ok';
          // outcome 'pending' = link STAYS open; skip everything below.
          if (outcome === 'pending') continue;
        } else {
          // case + work_order entity-level cancel deferred to a future
          // Phase 1.B.x followup. Emit the deferred-cancel audit event but
          // DO continue with link resolution + child workflow cancel — the
          // workflow layer is owned now; the entity row stays alive for
          // operator/owner action.
          await this.emit(instanceId, 'link_pending_entity_cancel', {
            payload: {
              link_id: link.id,
              parent_instance_id: instanceId,
              child_entity_kind: link.child_entity_kind,
              child_entity_id: link.child_entity_id,
              reason: `phase_1b_${link.child_entity_kind}_entity_cancel_pending`,
            },
          });
          entityCancelDeferred = true;
        }

        if (!entityCancelOk && !entityCancelDeferred) {
          // Booking outcome was 'not_found' — already gone, treat as ok.
          entityCancelOk = true;
        }

        // Step b: cancel child workflow_instance recursively. Use
        // `cancelInstanceById` directly — for booking children, the
        // entity row was just deleted and the booking_id was SET NULL,
        // so `cancelInstance(child_entity_kind, child_entity_id, …)`
        // would miss the orphaned-but-still-active workflow_instance.
        if (link.child_instance_id) {
          await this.cancelInstanceById(
            link.child_instance_id,
            tenantId,
            'parent_workflow_cancelled',
            { triggeredByLinkId: link.id, parentInstanceId: instanceId },
            visited,
          );
        }

        // Step c: resolve the link row.
        await this.resolveLinkRow(
          link.id,
          instanceId,
          link.child_entity_kind,
          link.child_entity_id,
          tenantId,
        );
      } catch (err) {
        // Per-link defense: one transient failure (DB blip, FK shake) must
        // NOT abort the cascade. Log + emit pending-cancel marker so ops
        // see the link in the audit feed and can finish manually.
        console.error('[workflow] cancelInstance: link cascade error', {
          link_id: link.id,
          err,
        });
        try {
          await this.emit(instanceId, 'link_pending_entity_cancel', {
            payload: {
              link_id: link.id,
              parent_instance_id: instanceId,
              child_entity_kind: link.child_entity_kind,
              child_entity_id: link.child_entity_id,
              reason: 'cascade_error',
              error: err instanceof Error ? err.message : String(err),
            },
          });
        } catch {
          // Audit emit best-effort; if it also fails, just continue.
        }
      }
    }
  }

  /**
   * Try to cancel a child booking via `delete_booking_with_guard` (00292).
   * Returns:
   *   - 'ok'        — RPC returned `kind: 'rolled_back'`. Caller proceeds
   *                   with link resolution + child workflow cancel.
   *   - 'not_found' — RPC raised `booking.not_found` (P0002). Caller treats
   *                   as success: the booking is already gone, link
   *                   resolution can proceed.
   *   - 'pending'   — RPC returned `kind: 'partial_failure'` (recurrence
   *                   series alive) OR threw a non-'not_found' exception.
   *                   Caller MUST skip link resolution so ops can finish.
   *
   * This helper emits `link_pending_entity_cancel` itself for the pending
   * branches so the caller stays a clean dispatcher. Spec §3.6.
   */
  private async tryCancelBookingForCascade(
    linkId: string,
    parentInstanceId: string,
    bookingId: string,
    tenantId: string,
  ): Promise<'ok' | 'not_found' | 'pending'> {
    let data: unknown = null;
    let error: { code?: string; message?: string } | null = null;
    try {
      const res = await this.supabase.admin.rpc('delete_booking_with_guard', {
        p_booking_id: bookingId,
        p_tenant_id: tenantId,
      });
      data = res.data;
      error = res.error as { code?: string; message?: string } | null;
    } catch (err) {
      // Network / supabase-js client error — treat as transient; pending.
      await this.emit(parentInstanceId, 'link_pending_entity_cancel', {
        payload: {
          link_id: linkId,
          parent_instance_id: parentInstanceId,
          child_entity_kind: 'booking',
          child_entity_id: bookingId,
          reason: 'booking_compensation_exception',
          error: err instanceof Error ? err.message : String(err),
        },
      });
      return 'pending';
    }

    if (error) {
      // 'booking.not_found' surfaces as a P0002 raise (00292:86); the
      // supabase-js error.message carries the literal text.
      const msg = String(error.message ?? '');
      if (msg.includes('booking.not_found')) {
        return 'not_found';
      }
      await this.emit(parentInstanceId, 'link_pending_entity_cancel', {
        payload: {
          link_id: linkId,
          parent_instance_id: parentInstanceId,
          child_entity_kind: 'booking',
          child_entity_id: bookingId,
          reason: 'booking_compensation_exception',
          error: msg,
        },
      });
      return 'pending';
    }

    const parsed = data as
      | { kind: 'rolled_back' }
      | { kind: 'partial_failure'; blocked_by?: string[] }
      | null;

    if (!parsed || typeof parsed !== 'object' || !('kind' in parsed)) {
      // Malformed payload — treat as pending.
      await this.emit(parentInstanceId, 'link_pending_entity_cancel', {
        payload: {
          link_id: linkId,
          parent_instance_id: parentInstanceId,
          child_entity_kind: 'booking',
          child_entity_id: bookingId,
          reason: 'booking_compensation_malformed_payload',
        },
      });
      return 'pending';
    }

    if (parsed.kind === 'partial_failure') {
      await this.emit(parentInstanceId, 'link_pending_entity_cancel', {
        payload: {
          link_id: linkId,
          parent_instance_id: parentInstanceId,
          child_entity_kind: 'booking',
          child_entity_id: bookingId,
          reason: 'booking_guard_partial_failure',
          blocked_by: parsed.blocked_by ?? [],
        },
      });
      return 'pending';
    }

    return 'ok';
  }

  /**
   * Mark a workflow_instance_links row as resolved with
   * `resolution_kind='parent_cancelled'` and emit the matching
   * `link_resolved` audit event. Wraps the UPDATE in try/catch so a
   * transient DB blip on the resolution doesn't abort the surrounding
   * cascade — instead emits `link_pending_entity_cancel` with reason
   * `link_resolve_update_failed` so ops can finish manually.
   *
   * Wake-handler race (codex IMPORTANT 2 remediation, 2026-05-12): the
   * wake handler at `workflow-spawn-wake.handler.ts:304` also claims
   * links via `UPDATE … WHERE id=$1 AND resolved_at IS NULL`. Without
   * a `.is('resolved_at', null)` guard here, a concurrent wake-resolve
   * (`resolution_kind='condition_met'`) gets overwritten to
   * `'parent_cancelled'` AND a duplicate `link_resolved` event fires.
   * We now add `.is('resolved_at', null)` + check the affected row
   * count — on 0 rows, the other path already resolved this link;
   * do NOT emit `link_resolved` (it would double up).
   */
  private async resolveLinkRow(
    linkId: string,
    parentInstanceId: string,
    childEntityKind: WorkflowEntityKind,
    childEntityId: string,
    tenantId: string,
  ): Promise<void> {
    try {
      const res = await this.supabase.admin
        .from('workflow_instance_links')
        .update({ resolved_at: new Date().toISOString(), resolution_kind: 'parent_cancelled' })
        .eq('id', linkId)
        .eq('tenant_id', tenantId)
        .is('resolved_at', null)
        .select('id')
        .maybeSingle();
      const updateError = (res as { error?: unknown } | null)?.error;
      if (updateError) {
        throw updateError;
      }
      if (!res.data) {
        // Lost the race — another path (wake handler or Tier 1 cron
        // sweeper) already resolved this link with a different
        // resolution_kind ('condition_met' or 'timeout'). The other path
        // emits its own `link_resolved`; we MUST NOT emit a duplicate.
        // Log at info-level so ops sees the race in the audit feed.
        // Codex BLOCKER remediation (2026-05-12 Phase 1.C): this is now
        // a hot path on the parent-cancel cascade because the cascade
        // enumerates ALL links (not just resolved_at IS NULL), so a
        // cron-claimed link's link-resolve step lands here cleanly.
        console.info('[workflow] resolveLinkRow: already resolved by concurrent path', {
          link_id: linkId,
          parent_instance_id: parentInstanceId,
        });
        return;
      }
      await this.emit(parentInstanceId, 'link_resolved', {
        payload: {
          link_id: linkId,
          parent_instance_id: parentInstanceId,
          child_entity_kind: childEntityKind,
          child_entity_id: childEntityId,
          resolution_kind: 'parent_cancelled',
        },
      });
    } catch (err) {
      console.error('[workflow] resolveLinkRow: UPDATE failed', { link_id: linkId, err });
      await this.emit(parentInstanceId, 'link_pending_entity_cancel', {
        payload: {
          link_id: linkId,
          parent_instance_id: parentInstanceId,
          child_entity_kind: childEntityKind,
          child_entity_id: childEntityId,
          reason: 'link_resolve_update_failed',
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  /**
   * Legacy thin shim — preserves the pre-Phase-1.B call site shape used
   * by ReclassifyService (and any future ticket-only caller). Routes to
   * `cancelInstance('case', ...)` so the new cascade behaviour applies
   * uniformly.
   *
   * Pre-Phase-1.B signature took `actorUserId: string | null` and returned
   * `Promise<string[]>` (cancelled instance ids). Phase 1.B drops both:
   *   - actorUserId: not surfaced on the polymorphic API; the
   *     `cancelled_by` column was always null in production callers.
   *     Restore via the `cascadeContext` audit-event payload if needed.
   *   - return value: callers ignored it (verified via
   *     `grep -r cancelInstanceForTicket apps/api/src/`).
   */
  async cancelInstanceForTicket(
    ticketId: string,
    tenantId: string,
    reason: string,
  ): Promise<void> {
    return this.cancelInstance('case', ticketId, tenantId, reason);
  }

  /**
   * Walk the spawn-link chain from `parentInstanceId` upwards, checking
   * whether spawning a child of kind `childEntityKind` and id
   * `childEntityId` would (a) attach to a terminated parent, (b) push
   * the chain past the depth limit, or (c) re-enter an ancestor entity
   * (cycle).
   *
   * Spec: docs/superpowers/specs/2026-05-12-universal-workflow-architecture-design.md §3.6
   * (Cycle detection — visited-set, not just depth limit).
   *
   * ── Implementation ─────────────────────────────────────────────────
   *
   * Iterative walk on `workflow_instance_links` (TS-side; one round-trip
   * per ancestor level). Phase 1 is single-spawn — a child has at most
   * ONE inbound link, so `LIMIT 1` is correct on the per-step query.
   *
   * NOTE: there is NO RPC named `exec_spawn_link_chain_query`. The
   * iterative walk is canonical. A future Phase 3 perf optimization
   * might convert this to a recursive CTE RPC — until then, the TS
   * walk is the source of truth and the only callable.
   *
   * @returns `{ ok: true }` when the spawn is safe; otherwise an
   *          `{ ok: false, reason }` discriminator carrying the
   *          violation kind (and `depth` when relevant).
   */
  async checkSpawnLinkSafety(
    parentInstanceId: string,
    tenantId: string,
    childEntityKind: WorkflowEntityKind,
    childEntityId: string,
  ): Promise<
    | { ok: true }
    | { ok: false; reason: 'parent_terminated' | 'cycle_detected' | 'depth_exceeded'; depth?: number }
  > {
    // Step 1: parent must exist + be non-terminal. Also pull the
    // parent's polymorphic entity (entity_kind + matching <kind>_id)
    // so we can detect self-spawn-at-root — a parent at the chain root
    // has no inbound link, so the ancestor walk would return ok
    // immediately even when the candidate child IS the parent's own
    // entity. The visited set must contain the parent's entity from
    // step 0. (codex IMPORTANT 1 remediation, 2026-05-12)
    const { data: parentRow } = await this.supabase.admin
      .from('workflow_instances')
      .select('status, entity_kind, case_id, work_order_id, booking_id')
      .eq('id', parentInstanceId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!parentRow) {
      // Missing or cross-tenant — treat as terminated for safety.
      return { ok: false, reason: 'parent_terminated' };
    }
    const parent = parentRow as {
      status: string;
      entity_kind: WorkflowEntityKind;
      case_id: string | null;
      work_order_id: string | null;
      booking_id: string | null;
    };
    if (parent.status === 'cancelled' || parent.status === 'completed' || parent.status === 'failed') {
      return { ok: false, reason: 'parent_terminated' };
    }

    // Self-spawn-at-root cycle check: would the candidate child re-enter
    // the parent's own entity? `parent.<kind>_id` may be NULL for
    // booking-children whose booking row was deleted (booking_id ON
    // DELETE SET NULL — 00369:231-233); compare only when present.
    const parentEntityId =
      parent.entity_kind === 'case'
        ? parent.case_id
        : parent.entity_kind === 'work_order'
          ? parent.work_order_id
          : parent.booking_id;
    if (
      parent.entity_kind === childEntityKind &&
      parentEntityId !== null &&
      parentEntityId === childEntityId
    ) {
      return { ok: false, reason: 'cycle_detected', depth: 0 };
    }

    // Step 2: walk ancestors. At each step, the parent's parent is found
    // by querying workflow_instance_links for a row whose
    // child_instance_id is the current node. Phase-1 single-spawn → at
    // most one inbound link per node.
    let depth = 0;
    let cursorInstanceId: string | null = parentInstanceId;
    while (cursorInstanceId) {
      const { data: linkRow } = await this.supabase.admin
        .from('workflow_instance_links')
        .select('id, parent_instance_id, parent_entity_kind, parent_entity_id')
        .eq('tenant_id', tenantId)
        .eq('child_instance_id', cursorInstanceId)
        .limit(1)
        .maybeSingle();

      if (!linkRow) {
        // Reached the chain root — no ancestor link. Safe.
        return { ok: true };
      }
      const ancestor = linkRow as {
        id: string;
        parent_instance_id: string;
        parent_entity_kind: WorkflowEntityKind;
        parent_entity_id: string;
      };

      // Cycle: would the candidate child re-enter this ancestor entity?
      if (
        ancestor.parent_entity_kind === childEntityKind &&
        ancestor.parent_entity_id === childEntityId
      ) {
        return { ok: false, reason: 'cycle_detected', depth };
      }

      depth++;
      if (depth >= SPAWN_LINK_DEPTH_LIMIT) {
        return { ok: false, reason: 'depth_exceeded', depth };
      }

      cursorInstanceId = ancestor.parent_instance_id;
    }

    return { ok: true };
  }

  /**
   * Throwing variant of `checkSpawnLinkSafety`. Maps the discriminated
   * result into `AppError(spawn_link.*, 422)`. No callers today; ships
   * for future Phase 3 spawn-RPC TS gates.
   *
   * Spec §3.12 lists the three Phase 1 codes:
   *   - spawn_link.parent_terminated
   *   - spawn_link.depth_exceeded
   *   - spawn_link.cycle_detected
   */
  async assertSpawnLinkSafe(
    parentInstanceId: string,
    tenantId: string,
    childEntityKind: WorkflowEntityKind,
    childEntityId: string,
  ): Promise<void> {
    const res = await this.checkSpawnLinkSafety(
      parentInstanceId,
      tenantId,
      childEntityKind,
      childEntityId,
    );
    if (res.ok) return;
    const detailParts: string[] = [];
    if (res.depth !== undefined) detailParts.push(`depth=${res.depth}`);
    detailParts.push(
      `parent=${parentInstanceId}`,
      `child=${childEntityKind}:${childEntityId}`,
    );
    throw new AppError(
      `spawn_link.${res.reason}` as KnownErrorCode,
      422,
      { detail: detailParts.join(' ') },
    );
  }

  async startForTicket(ticketId: string, workflowDefinitionId: string) {
    const tenant = TenantContext.current();

    // Cross-tenant FK leak fix (security audit 2026-05-08, site 1):
    // workflow_definitions read keyed by id alone. supabase.admin bypasses
    // RLS, so a foreign-tenant workflow uuid (e.g. smuggled via a request
    // type pointing across tenants) would be returned blind and used to
    // start an instance — branching on a foreign workflow's nodes/edges.
    // Filter by tenant.
    //
    // Phase 1.5 sub-step 6.A, Change 5 (IMPORTANT 7 closure): also filter
    // by status='published'. Migration 00400 introduced the 'archived'
    // status for workflow_definitions superseded by a newer version on the
    // same rule. The start path MUST refuse archived definitions —
    // otherwise a delayed handler or race could spawn a new instance on an
    // archived graph, breaking the "in-flight instances stay on their
    // published version" invariant. resume() stays status-agnostic.
    const { data: definition } = await this.supabase.admin
      .from('workflow_definitions')
      .select('*')
      .eq('id', workflowDefinitionId)
      .eq('tenant_id', tenant.id)
      .eq('status', 'published')
      .maybeSingle();

    if (!definition) {
      // Differentiate "not published" vs "not found" so admins debugging a
      // failed start know to look at the workflow_definitions.status. The
      // extra read costs one round-trip on the failure path only.
      const { data: archivedOrDraft } = await this.supabase.admin
        .from('workflow_definitions')
        .select('status')
        .eq('id', workflowDefinitionId)
        .eq('tenant_id', tenant.id)
        .maybeSingle();
      if (archivedOrDraft) {
        throw new AppError('workflow.definition_not_published', 422, {
          detail: `workflow_definition ${workflowDefinitionId} has status='${(archivedOrDraft as { status: string }).status}', not 'published'`,
        });
      }
      return null;
    }

    const graph = definition.graph_definition as unknown as WorkflowGraph;
    if (!graph?.nodes?.length) return null;

    const triggerNode = graph.nodes.find((n) => n.type === 'trigger');
    if (!triggerNode) return null;

    const { data: instance, error } = await this.supabase.admin
      .from('workflow_instances')
      .insert({
        tenant_id: tenant.id,
        workflow_definition_id: workflowDefinitionId,
        workflow_version: definition.version,
        ticket_id: ticketId,
        current_node_id: triggerNode.id,
        status: 'active',
        context: {},
      })
      .select()
      .single();

    if (error) throw error;

    await this.emit(instance.id, 'instance_started', { node_id: triggerNode.id, node_type: 'trigger' });
    await this.advance(instance.id, graph, triggerNode.id, ticketId);

    return instance;
  }

  /**
   * Phase 1.5 sub-step 6.A.Y — booking-kind start path.
   *
   * Mirrors `startForTicket` shape with two differences:
   *  - inserts `entity_kind='booking'` + `booking_id` instead of `ticket_id`.
   *    The workflow_instances polymorphic CHECK at 00369:399-418 enforces
   *    the (entity_kind, polymorphic-id) coupling.
   *  - the definition SELECT gates `status='published'` (IMPORTANT 7 — same
   *    gate as startForTicket added in Change 5). Archived/draft → 422
   *    `workflow.definition_not_published`.
   *
   * Returns the inserted row, or `null` if the definition is missing /
   * cross-tenant / has no nodes / has no trigger node — same shape as
   * startForTicket's failure paths.
   *
   * `TenantContext.run({...})` MUST be active at the call site
   * (controller middleware guarantees this).
   */
  async startForBooking(bookingId: string, workflowDefinitionId: string) {
    const tenant = TenantContext.current();

    const { data: definition } = await this.supabase.admin
      .from('workflow_definitions')
      .select('*')
      .eq('id', workflowDefinitionId)
      .eq('tenant_id', tenant.id)
      .eq('status', 'published')
      .maybeSingle();

    if (!definition) {
      // Differentiate "not published" vs "not found" — same shape as
      // startForTicket's failure branch.
      const { data: archivedOrDraft } = await this.supabase.admin
        .from('workflow_definitions')
        .select('status')
        .eq('id', workflowDefinitionId)
        .eq('tenant_id', tenant.id)
        .maybeSingle();
      if (archivedOrDraft) {
        throw new AppError('workflow.definition_not_published', 422, {
          detail: `workflow_definition ${workflowDefinitionId} has status='${(archivedOrDraft as { status: string }).status}', not 'published'`,
        });
      }
      return null;
    }

    const graph = definition.graph_definition as unknown as WorkflowGraph;
    if (!graph?.nodes?.length) return null;

    const triggerNode = graph.nodes.find((n) => n.type === 'trigger');
    if (!triggerNode) return null;

    const { data: instance, error } = await this.supabase.admin
      .from('workflow_instances')
      .insert({
        tenant_id: tenant.id,
        workflow_definition_id: workflowDefinitionId,
        workflow_version: definition.version,
        entity_kind: 'booking',
        booking_id: bookingId,
        current_node_id: triggerNode.id,
        status: 'active',
        context: {},
      })
      .select()
      .single();

    if (error) throw error;

    await this.emit(instance.id, 'instance_started', { node_id: triggerNode.id, node_type: 'trigger' });
    await this.advance(instance.id, graph, triggerNode.id, bookingId);

    return instance;
  }

  async advance(instanceId: string, graph: WorkflowGraph, fromNodeId: string, ticketId: string, edgeCondition?: string, ctx?: WorkflowRunContext) {
    const edges = graph.edges.filter((e) => e.from === fromNodeId);
    if (edges.length === 0) return;

    let nextEdge = edges[0];
    if (edgeCondition) {
      const conditionEdge = edges.find((e) => e.condition === edgeCondition);
      if (conditionEdge) nextEdge = conditionEdge;
    }

    const nextNode = graph.nodes.find((n) => n.id === nextEdge.to);
    if (!nextNode) return;

    if (!ctx?.dryRun) {
      // Cross-tenant FK leak fix (security audit 2026-05-08, codex post-fix
      // review): the prior version updated workflow_instances by id alone.
      // supabase.admin bypasses RLS, so a colliding instance id would let one
      // tenant advance another tenant's workflow. advance() is only invoked
      // from inside a TenantContext.run scope (startForTicket → controller's
      // ambient context; executeNode → tenant resolved at the top of each
      // node branch; resume() → TenantContext.run({id: instance.tenant_id})).
      // Filter the write defensively.
      const advTenant = TenantContext.current();
      await this.supabase.admin
        .from('workflow_instances')
        .update({ current_node_id: nextNode.id })
        .eq('id', instanceId)
        .eq('tenant_id', advTenant.id);
    }

    await this.executeNode(instanceId, graph, nextNode, ticketId, ctx);
  }

  private async executeNode(instanceId: string, graph: WorkflowGraph, node: WorkflowNode, ticketId: string, ctx?: WorkflowRunContext) {
    const tenant = ctx?.dryRun ? null : TenantContext.current();

    await this.emit(instanceId, 'node_entered', { node_id: node.id, node_type: node.type }, ctx);
    if (ctx) ctx.path.push(node.id);

    switch (node.type) {
      case 'trigger':
        await this.advance(instanceId, graph, node.id, ticketId, undefined, ctx);
        break;

      case 'assign': {
        // B.2.A.Step9 — workflow engine `assign` node cutover to §3.2
        // `set_entity_assignment` RPC (00327 v2). Spec lines 1870-1873.
        //
        // Pre-Step 9 this node wrote directly to `tickets.assigned_*`
        // via `.from('tickets').update(...)`, bypassing:
        //   - the orchestrator's idempotency cache (command_operations)
        //   - the orchestrator's atomic activity / domain_event emission
        //   - the RPC's defense-in-depth tenant FK validation
        //   - the cross-table polymorphism (status_category transition
        //     handled by 00327, not by the workflow engine)
        //
        // The RPC's payload schema is `{assigned_team_id, assigned_user_id,
        // assigned_vendor_id}` (00327:64-71). All three are optional;
        // unset keys keep current value, explicit null clears. The
        // workflow engine's node.config carries `team_id` and `user_id`
        // historically — preserve that shape on the node-config side
        // and translate to the RPC's canonical keys. No `vendor_id` on
        // node.config today (the assign UI doesn't surface vendor
        // assignment from a workflow); add when the editor supports it.
        //
        // Idempotency key shape: workflow:assignment:<instance>:<node>:<entity>.
        // Stable across replays (same instance + same node + same entity
        // ⇒ same key ⇒ command_operations short-circuits).
        const teamId = node.config.team_id as string | undefined;
        const userId = node.config.user_id as string | undefined;
        if (!ctx?.dryRun) {
          if (tenant && (teamId !== undefined || userId !== undefined)) {
            // Tenant-validate FKs at the RPC layer (00327 validates via
            // `validate_assignees_in_tenant`). TS-side validation removed
            // — the RPC is the single source of truth post-cutover.
            const payload: Record<string, unknown> = {};
            if (teamId !== undefined) payload.assigned_team_id = teamId;
            if (userId !== undefined) payload.assigned_user_id = userId;

            const idempotencyKey = buildWorkflowAssignmentIdempotencyKey(
              instanceId,
              node.id,
              ticketId,
            );
            // Resolve entity kind: cases live in `tickets`; work_orders
            // live in `work_orders` (post step1c.10c). The workflow
            // engine's instances bind to one or the other via the
            // calling ticket id; today every workflow_instance.ticket_id
            // points at a case (tickets table), per the auto-workflow
            // start path at ticket.service.ts:902-917. Step 11 will add
            // WO-side workflow instances; until then 'case' is correct
            // for every live caller.
            const { error } = await this.supabase.admin.rpc(
              'set_entity_assignment',
              {
                p_entity_id: ticketId,
                p_entity_kind: 'case',
                p_tenant_id: tenant.id,
                // Workflow engine has no actor — the engine itself is
                // the system actor. Null lets the RPC's actor lookup
                // (00327:98-103 pattern) fall through cleanly.
                p_actor_user_id: null,
                p_idempotency_key: idempotencyKey,
                p_payload: payload,
              },
            );
            if (error) throw mapRpcErrorToAppError(error);
          }
        }
        await this.advance(instanceId, graph, node.id, ticketId, undefined, ctx);
        break;
      }

      case 'update_ticket': {
        // B.2.A.Step9 — workflow engine `update_ticket` node cutover to
        // §3.0 `update_entity_combined` RPC (00335 v5). Spec lines 1870-1873.
        //
        // Pre-Step 9 this node wrote directly to `tickets` via
        // `.from('tickets').update(...)`, with a 29-field allowlist
        // that drifted far from what the §3.0 orchestrator actually
        // supports. Option 2 (decided 2026-05-11): tighten the
        // allowlist to the orchestrator's 14-field surface and reject
        // anything else with `workflow.update_ticket_field_not_allowed`.
        //
        // The 17 orphan fields and their phased remediation are
        // documented in docs/follow-ups/b2-followups.md.
        const fields = node.config.fields as Record<string, unknown> | undefined;
        if (!ctx?.dryRun && fields && tenant) {
          // 1. Reject any field outside the tightened allowlist up-front.
          //    Throwing (vs. silent drop) surfaces workflow definition
          //    bugs at execution time. Per `project_no_wave1_yet` memory
          //    no production tenant currently depends on these workflows
          //    — risk-free in customer terms.
          const offendingFields = Object.keys(fields).filter(
            (k) => !UPDATE_TICKET_ALLOWED_FIELDS.has(k),
          );
          if (offendingFields.length > 0) {
            // 422 unprocessable entity (not 400): the request payload
            // is syntactically valid jsonb of the right shape, but the
            // workflow definition itself is misconfigured — only an
            // admin can fix it. Detail names the offending fields so
            // the audit log surfaces actionable triage data; the
            // user-facing copy (messages.en/nl) points to the
            // followups doc for the supported set.
            throw new AppError('workflow.update_ticket_field_not_allowed', 422, {
              detail: `workflow update_ticket node attempted to write disallowed field(s): ${offendingFields.join(', ')}`,
            });
          }

          // 2. Honest no-op short-circuit: empty fields object ⇒ no work.
          //    Same shape as TicketService.update at ticket.service.ts:1118-1125.
          const fieldKeys = Object.keys(fields);
          if (fieldKeys.length === 0) {
            await this.advance(instanceId, graph, node.id, ticketId, undefined, ctx);
            break;
          }

          // 3. Build the orchestrator patches payload, bucketing each
          //    allowlisted field into its branch. Mirrors the case-side
          //    `TicketService.buildPatchesPayloadForCase` shape exactly.
          const patches = await this.buildPatchesFromUpdateTicketFields(
            fields,
            tenant.id,
          );

          if (Object.keys(patches).length === 0) {
            // Could happen if the field set was non-empty but all keys
            // were filtered out by hasOwnProperty semantics (shouldn't
            // happen given the allowlist gate above, but defensive).
            await this.advance(instanceId, graph, node.id, ticketId, undefined, ctx);
            break;
          }

          // 4. Resolve entity kind. Today every workflow_instance.ticket_id
          //    points at a case (per the auto-workflow start path at
          //    ticket.service.ts:902-917). Plan branch will raise
          //    `update_entity_combined.plan_not_supported_on_case` if a
          //    workflow author writes planned_start_at on a case; that's
          //    the right shape — the engine has no way to author a WO-
          //    targeted workflow today. Step 11 will resolve WO-side
          //    workflow instances by inspecting workflow_instances.parent_kind.
          const idempotencyKey = buildWorkflowUpdateTicketIdempotencyKey(
            instanceId,
            node.id,
            ticketId,
          );
          const { error } = await this.supabase.admin.rpc(
            'update_entity_combined',
            {
              p_entity_kind: 'case',
              p_entity_id: ticketId,
              p_tenant_id: tenant.id,
              // Workflow engine is the system actor. Null lets the
              // RPC's actor lookup (00335:241-252) fall through.
              p_actor_user_id: null,
              p_idempotency_key: idempotencyKey,
              p_patches: patches,
            },
          );
          if (error) throw mapRpcErrorToAppError(error);
        }
        await this.advance(instanceId, graph, node.id, ticketId, undefined, ctx);
        break;
      }

      case 'notification': {
        if (!ctx?.dryRun && tenant) {
          // Phase 1.B polymorphization (spec §3.6). `related_entity_type`
          // routes through projectLegacyEntityType so future booking /
          // work_order workflows emit their kind literal while case-kind
          // workflows stay on the legacy `'ticket'` literal expected by
          // notification consumers. Kind is hardcoded 'case' until
          // executeNode threads the polymorphic kind through (followup;
          // executeNode is case-only today per ticketId param shape).
          const entityKind: WorkflowEntityKind = 'case';
          await this.supabase.admin.from('notifications').insert({
            tenant_id: tenant.id,
            notification_type: (node.config.notification_type as string) ?? 'workflow_notification',
            target_channel: 'in_app',
            related_entity_type: this.projectLegacyEntityType(entityKind),
            related_entity_id: ticketId,
            subject: (node.config.subject as string) ?? 'Workflow notification',
            body: (node.config.body as string) ?? '',
            status: 'pending',
          });
        }
        await this.advance(instanceId, graph, node.id, ticketId, undefined, ctx);
        break;
      }

      case 'condition': {
        const field = node.config.field as string;
        const operator = node.config.operator as string;
        const value = node.config.value;

        let ticket: Record<string, unknown> | null = null;
        if (ctx?.dryRun) {
          ticket = ctx.simulatedTicket ?? {};
        } else {
          // Cross-tenant FK leak fix (site 2): condition node reads tickets
          // by id alone and BRANCHES on the result. A workflow_instance
          // pointing at a foreign-tenant ticket (or an id collision) would
          // route execution based on another tenant's data. Filter by
          // tenant — when no context is set (resume() callsite, see site 5
          // fix below), fall back to instance.tenant_id captured upstream.
          const condTenant = TenantContext.currentOrNull();
          let q = this.supabase.admin.from('tickets').select('*').eq('id', ticketId);
          if (condTenant) q = q.eq('tenant_id', condTenant.id);
          const { data } = await q.maybeSingle();
          ticket = data;
        }
        if (!ticket) break;

        const actual = ticket[field];
        let result = 'default';
        if (operator === 'equals' && actual === value) result = 'true';
        else if (operator === 'not_equals' && actual !== value) result = 'true';
        else if (operator === 'in' && Array.isArray(value) && value.includes(actual)) result = 'true';
        else result = 'false';

        await this.emit(instanceId, 'decision_made', { node_id: node.id, node_type: 'condition', decision: result }, ctx);
        await this.advance(instanceId, graph, node.id, ticketId, result, ctx);
        break;
      }

      case 'create_child_tasks': {
        const tasks = node.config.tasks as Array<{
          title: string;
          description?: string;
          assigned_team_id?: string;
          assigned_user_id?: string;
          assigned_vendor_id?: string;
          interaction_mode?: string;
          priority?: string;
          sla_policy_id?: string | null;
        }> | undefined;

        if (ctx?.dryRun) {
          await this.emit(instanceId, 'node_entered', {
            node_id: node.id, node_type: 'create_child_tasks',
            payload: { dry_run_would_create: tasks?.length ?? 0 },
          }, ctx);
        } else if (tasks && tasks.length > 0 && tenant) {
          // B.2.A.Step8 — cut over from per-task loop to the atomic batch RPC
          // (`dispatch_child_work_orders_batch` 00337). Spec §3.4
          // lines 2228-2234: a single tx commits all N children or rolls
          // back the entire batch, eliminating the partial-fanout failure
          // mode where the workflow advanced after dispatch #3 of 5 failed
          // (§1.18, severity:critical).
          //
          // Stable clientRequestId per (instanceId, node.id) — workflow
          // resume replays the same node with the same id, so the batch
          // idempotency key is stable across retries.
          const clientRequestId = `workflow:${instanceId}:${node.id}`;
          const taskDtos = tasks.map((task, i) => ({
            title: task.title?.trim() || `Subtask ${i + 1}`,
            description: task.description,
            assigned_team_id: task.assigned_team_id,
            assigned_user_id: task.assigned_user_id,
            assigned_vendor_id: task.assigned_vendor_id,
            priority: task.priority,
            interaction_mode: task.interaction_mode as 'internal' | 'external' | undefined,
            // sla_policy_id semantics preserved: explicit key (including
            // null) passes through; absent falls back to resolveChildSla.
            ...(Object.prototype.hasOwnProperty.call(task, 'sla_policy_id')
              ? { sla_id: task.sla_policy_id ?? null }
              : {}),
          }));
          try {
            await this.dispatchService.dispatchBatch(
              ticketId,
              taskDtos,
              '__system__',
              clientRequestId,
            );
          } catch (err) {
            // Codex-S8-I3 (F-IMP-3): the pre-remediation behaviour was
            // to console.error + advance the workflow as if nothing
            // happened. That silently leaves the workflow in a state
            // that says "child tasks created" when in fact ZERO were
            // committed (batch is all-or-nothing). Same severity class
            // as the legacy per-task swallow that F-CRIT-4 retired.
            //
            // Fix: halt the workflow at this node. Mark the instance
            // status='failed' so ops can see it on the workflow run +
            // re-investigate / re-run. Emit a node_failed event so the
            // audit feed records the reason. Do NOT call advance() —
            // the workflow's claim that children exist would be a lie.
            console.error('[workflow] create_child_tasks: batch dispatch failed', err);
            if (tenant) {
              await this.supabase.admin
                .from('workflow_instances')
                .update({ status: 'failed' })
                .eq('id', instanceId)
                .eq('tenant_id', tenant.id);
            }
            await this.emit(
              instanceId,
              'node_failed',
              {
                node_id: node.id,
                node_type: 'create_child_tasks',
                payload: {
                  reason: 'dispatch_batch_failed',
                  message: err instanceof Error ? err.message : String(err),
                  task_count: taskDtos.length,
                },
              },
              ctx,
            );
            break;
          }
        }

        await this.advance(instanceId, graph, node.id, ticketId, undefined, ctx);
        break;
      }

      case 'approval': {
        if (ctx?.dryRun) {
          ctx.stoppedAt = { node_id: node.id, node_type: 'approval', reason: 'approval' };
          await this.emit(instanceId, 'instance_waiting', { node_id: node.id, node_type: 'approval', payload: { waiting_for: 'approval' } }, ctx);
          return;
        }
        if (tenant) {
          // Phase 1.5 sub-step 6.A, Change 2: shape-aware approval executor.
          //
          // Two graph shapes coexist in production:
          //
          //  (LEGACY) Pre-Phase-1.5: scalar `approver_person_id` /
          //    `approver_team_id` on `node.config`. Hardcoded `entityKind=
          //    'case'`. Single-row insert. Kept unchanged so old workflows
          //    keep working.
          //
          //  (PHASE 1.5) New compiled graphs: `required_approvers` array on
          //    `node.config` + `threshold` ∈ ('all','any'). entity_kind read
          //    off the live workflow_instance via getEntityKindForInstance().
          //    N-row insert with shared approval_chain_id, threshold-driven
          //    parallel_group, chain_threshold per row, workflow_instance_id
          //    + workflow_node_id stamped on each.
          //
          // Discrimination is by shape: presence of an array
          // `required_approvers` toggles the new path. The two paths share
          // the tenant-validation block (assertTenantOwned).
          const requiredApproversRaw = node.config.required_approvers as
            | Array<{ type: 'person' | 'team'; id: string }>
            | undefined;
          const isPhase15Shape =
            Array.isArray(requiredApproversRaw) && requiredApproversRaw.length > 0;

          if (isPhase15Shape) {
            const polymorphic = await this.getEntityKindForInstance(instanceId);
            const targetEntityType = this.projectLegacyEntityType(polymorphic.kind);
            const targetEntityId = polymorphic.entityId;

            const thresholdRaw = node.config.threshold as 'all' | 'any' | undefined;
            const chainThreshold: 'all' | 'any' = thresholdRaw ?? 'all';
            const approvalChainId = randomUUID();
            // For threshold='all' use a per-execution parallel_group key so
            // legacy 00310 grant logic counts siblings correctly; for 'any'
            // parallel_group stays NULL (chain_threshold is the canonical
            // signal post-00401).
            const parallelGroup =
              chainThreshold === 'all' ? `wf-${node.id}-${instanceId}` : null;

            for (const approver of requiredApproversRaw!) {
              const approverPersonId = approver.type === 'person' ? approver.id : undefined;
              const approverTeamId = approver.type === 'team' ? approver.id : undefined;
              if (approverPersonId) {
                await assertTenantOwned(
                  this.supabase,
                  'persons',
                  approverPersonId,
                  tenant.id,
                  { entityName: 'approver person' },
                );
              }
              if (approverTeamId) {
                await assertTenantOwned(
                  this.supabase,
                  'teams',
                  approverTeamId,
                  tenant.id,
                  { entityName: 'approver team' },
                );
              }
              await this.supabase.admin.from('approvals').insert({
                tenant_id: tenant.id,
                target_entity_type: targetEntityType,
                target_entity_id: targetEntityId,
                approver_person_id: approverPersonId,
                approver_team_id: approverTeamId,
                approval_chain_id: approvalChainId,
                parallel_group: parallelGroup,
                chain_threshold: chainThreshold,
                workflow_instance_id: instanceId,
                workflow_node_id: node.id,
                status: 'pending',
              });
            }
          } else {
            // Pre-Phase-1.5 legacy single-approver shape. Unchanged from the
            // pre-Phase-1.5 code path: hardcoded entityKind='case', single
            // insert. Tenant validation runs identically.
            //
            // Note for new workflow authors: prefer the Phase 1.5 shape
            // (required_approvers array). The compiler service that ships
            // in 6.A.X always emits the array shape.
            const approverPersonId = node.config.approver_person_id as string | undefined;
            const approverTeamId = node.config.approver_team_id as string | undefined;
            if (approverPersonId) {
              await assertTenantOwned(
                this.supabase,
                'persons',
                approverPersonId,
                tenant.id,
                { entityName: 'approver person' },
              );
            }
            if (approverTeamId) {
              await assertTenantOwned(
                this.supabase,
                'teams',
                approverTeamId,
                tenant.id,
                { entityName: 'approver team' },
              );
            }
            const entityKind: WorkflowEntityKind = 'case';
            await this.supabase.admin.from('approvals').insert({
              tenant_id: tenant.id,
              target_entity_type: this.projectLegacyEntityType(entityKind),
              target_entity_id: ticketId,
              approver_person_id: approverPersonId,
              approver_team_id: approverTeamId,
              status: 'pending',
            });
          }
        }
        // Cross-tenant write fix (codex post-fix review 2026-05-08): the
        // approval/wait/timer/end branches all mutated workflow_instances by
        // id alone. tenant guaranteed non-null in non-dry-run path (set at
        // the top of executeNode). Add explicit .eq('tenant_id', …).
        if (tenant) {
          await this.supabase.admin
            .from('workflow_instances')
            .update({ status: 'waiting', waiting_for: 'approval' })
            .eq('id', instanceId)
            .eq('tenant_id', tenant.id);
        }
        await this.emit(instanceId, 'instance_waiting', { node_id: node.id, node_type: 'approval', payload: { waiting_for: 'approval' } });
        break;
      }

      case 'wait_for': {
        const waitType = node.config.wait_type as string;
        if (ctx?.dryRun) {
          ctx.stoppedAt = { node_id: node.id, node_type: 'wait_for', reason: 'wait_for' };
          await this.emit(instanceId, 'instance_waiting', { node_id: node.id, node_type: 'wait_for', payload: { wait_type: waitType } }, ctx);
          return;
        }
        if (tenant) {
          await this.supabase.admin
            .from('workflow_instances')
            .update({ status: 'waiting', waiting_for: waitType })
            .eq('id', instanceId)
            .eq('tenant_id', tenant.id);
        }
        await this.emit(instanceId, 'instance_waiting', { node_id: node.id, node_type: 'wait_for', payload: { wait_type: waitType } });
        break;
      }

      case 'timer': {
        const delayMinutes = node.config.delay_minutes as number | undefined;
        if (ctx?.dryRun) {
          ctx.stoppedAt = { node_id: node.id, node_type: 'timer', reason: 'timer' };
          await this.emit(instanceId, 'instance_waiting', { node_id: node.id, node_type: 'timer', payload: { delay_minutes: delayMinutes } }, ctx);
          return;
        }
        if (delayMinutes && tenant) {
          const resumeAt = new Date(Date.now() + delayMinutes * 60_000);
          await this.supabase.admin
            .from('workflow_instances')
            .update({
              status: 'waiting',
              waiting_for: 'timer',
              context: { timer_resume_at: resumeAt.toISOString(), timer_node_id: node.id },
            })
            .eq('id', instanceId)
            .eq('tenant_id', tenant.id);
          await this.emit(instanceId, 'instance_waiting', { node_id: node.id, node_type: 'timer', payload: { resume_at: resumeAt.toISOString() } });
        }
        break;
      }

      case 'end': {
        if (!ctx?.dryRun && tenant) {
          await this.supabase.admin
            .from('workflow_instances')
            .update({ status: 'completed', completed_at: new Date().toISOString() })
            .eq('id', instanceId)
            .eq('tenant_id', tenant.id);
        }
        await this.emit(instanceId, 'instance_completed', { node_id: node.id, node_type: 'end' }, ctx);
        break;
      }

      case 'http_request': {
        const method = (node.config.method as string) ?? 'POST';
        const url = node.config.url as string;
        const headers = (node.config.headers as Record<string, string>) ?? {};
        const bodyTemplate = (node.config.body as string) ?? '';
        const saveAs = (node.config.save_response_as as string) ?? '';

        // Load ticket/context for template substitution
        // Cross-tenant FK leak fix (site 3) — EXFILTRATION VECTOR.
        // This node reads tickets.* and substitutes EVERY column into
        // user-authored URL/body/header templates, then sends the result
        // to a user-authored URL. Without a tenant filter, a workflow
        // instance pointing at a foreign-tenant ticket (or an id
        // collision) would exfiltrate the foreign tenant's row to THIS
        // tenant's webhook. Filter by tenant; resume() now installs a
        // tenant context so currentOrNull() resolves.
        let ticket: Record<string, unknown> | null = null;
        if (ctx?.dryRun) {
          ticket = ctx.simulatedTicket ?? {};
        } else {
          const httpTenant = TenantContext.currentOrNull();
          let q = this.supabase.admin.from('tickets').select('*').eq('id', ticketId);
          if (httpTenant) q = q.eq('tenant_id', httpTenant.id);
          const { data } = await q.maybeSingle();
          ticket = data;
        }

        const substitutedUrl = this.substituteTemplate(url, { ticket });
        const substitutedHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) {
          substitutedHeaders[k] = this.substituteTemplate(v, { ticket });
        }
        const substitutedBody = this.substituteTemplate(bodyTemplate, { ticket });

        if (ctx?.dryRun) {
          await this.emit(instanceId, 'node_entered', {
            node_id: node.id, node_type: 'http_request',
            payload: { dry_run_would_call: { method, url: substitutedUrl } },
          }, ctx);
          await this.advance(instanceId, graph, node.id, ticketId, undefined, ctx);
          break;
        }

        try {
          const init: RequestInit = {
            method,
            headers: { 'Content-Type': 'application/json', ...substitutedHeaders },
            signal: AbortSignal.timeout(20000),
          };
          if (method !== 'GET' && method !== 'DELETE' && substitutedBody) {
            init.body = substitutedBody;
          }
          const res = await fetch(substitutedUrl, init);
          let parsed: unknown = null;
          const text = await res.text();
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }

          await this.emit(instanceId, 'node_entered', {
            node_id: node.id, node_type: 'http_request',
            payload: { status: res.status, ok: res.ok, url: substitutedUrl, method },
          });

          if (saveAs) {
            // Cross-tenant FK leak fix (site 4): saveAs reads + writes
            // workflow_instances.context by id alone. Without a tenant
            // filter, a foreign-tenant instance with a colliding id could
            // be read (leak) and overwritten (tamper). Filter both the
            // read and the update. Falls back to no extra filter when no
            // tenant context is set (shouldn't happen post site-5 fix,
            // but defensive).
            const saveTenant = TenantContext.currentOrNull();
            let readQ = this.supabase.admin
              .from('workflow_instances')
              .select('context')
              .eq('id', instanceId);
            if (saveTenant) readQ = readQ.eq('tenant_id', saveTenant.id);
            const { data: inst } = await readQ.maybeSingle();
            const newCtx = { ...(inst?.context ?? {}), [saveAs]: parsed };
            let writeQ = this.supabase.admin
              .from('workflow_instances')
              .update({ context: newCtx })
              .eq('id', instanceId);
            if (saveTenant) writeQ = writeQ.eq('tenant_id', saveTenant.id);
            await writeQ;
          }
        } catch (err) {
          await this.emit(instanceId, 'instance_failed', {
            node_id: node.id, node_type: 'http_request',
            payload: { error: err instanceof Error ? err.message : 'HTTP request failed', url: substitutedUrl },
          });
          // Continue the workflow anyway — the failure is recorded. Alternative: halt.
        }

        await this.advance(instanceId, graph, node.id, ticketId, undefined, ctx);
        break;
      }

      default:
        await this.advance(instanceId, graph, node.id, ticketId, undefined, ctx);
    }
  }

  /**
   * Build the `p_patches` jsonb payload for `update_entity_combined`
   * (00335 v5) from a workflow `update_ticket` node's `config.fields`
   * object. Mirrors `TicketService.buildPatchesPayloadForCase` shape so
   * the engine and the controller PATCH path produce identical patches
   * for the same logical input.
   *
   * The caller must have already enforced the 14-field allowlist via
   * `UPDATE_TICKET_ALLOWED_FIELDS`. This method assumes every key in
   * `fields` is valid; unknown keys are dropped silently by the
   * bucketing (a defense-in-depth no-op given the allowlist gate).
   *
   * SLA branch: when `sla_id` is non-null, the orchestrator requires a
   * pre-computed `timers[]` array (00330:202-205 / 00335:357-373). The
   * business-hours calendar resolution lives in TS, so we call
   * `SlaService.buildTimersForRpc` here — same shape as the WO-side
   * helper at work-order.service.ts:469-480. A null sla_id clears the
   * policy (RPC's stop-only path); timers[] is omitted.
   *
   * Plan branch: the orchestrator rejects `plan` on cases
   * (00335:170-173). Workflow definitions today never start on a WO,
   * so a plan field on an update_ticket node is a misconfiguration —
   * the RPC's raise (`plan_not_supported_on_case`) surfaces it
   * cleanly. We still forward the keys; failing fast at the RPC layer
   * is the right shape.
   */
  private async buildPatchesFromUpdateTicketFields(
    fields: Record<string, unknown>,
    tenantId: string,
  ): Promise<Record<string, unknown>> {
    const has = (k: string) => Object.prototype.hasOwnProperty.call(fields, k);
    const patches: Record<string, unknown> = {};

    // Status branch — top-level (00335:159-160 / 254-281).
    if (has('status')) patches.status = fields.status;
    if (has('status_category')) patches.status_category = fields.status_category;
    if (has('waiting_reason')) patches.waiting_reason = fields.waiting_reason;

    // Priority — top-level (00335:163 / 283-337).
    if (has('priority')) patches.priority = fields.priority;

    // Assignment grouped (00335:161 / 339-355). Keys map verbatim:
    // assigned_team_id / assigned_user_id / assigned_vendor_id.
    if (
      has('assigned_team_id') ||
      has('assigned_user_id') ||
      has('assigned_vendor_id')
    ) {
      const assignment: Record<string, unknown> = {};
      if (has('assigned_team_id'))
        assignment.assigned_team_id = fields.assigned_team_id;
      if (has('assigned_user_id'))
        assignment.assigned_user_id = fields.assigned_user_id;
      if (has('assigned_vendor_id'))
        assignment.assigned_vendor_id = fields.assigned_vendor_id;
      patches.assignment = assignment;
    }

    // SLA grouped (00335:162 / 357-373). RPC schema: `{sla_id, timers?}`
    // per 00330:98-108. Non-null sla_id requires timers[]; null sla_id
    // clears (timers[] omitted).
    if (has('sla_id')) {
      const slaPayload: Record<string, unknown> = { sla_id: fields.sla_id };
      if (fields.sla_id !== null && fields.sla_id !== undefined) {
        slaPayload.timers = await this.slaService.buildTimersForRpc(
          fields.sla_id as string,
          tenantId,
        );
      }
      patches.sla = slaPayload;
    }

    // Plan branch: unreachable here. Plan fields are NOT in
    // `UPDATE_TICKET_ALLOWED_FIELDS` (the workflow update_ticket node always
    // targets a case, and the orchestrator's plan branch is WO-only per
    // 00335:170-173). Any node config carrying `planned_start_at` or
    // `planned_duration_minutes` is rejected up front at line ~343 with
    // `workflow.update_ticket_field_not_allowed` (422) before this builder
    // even runs. Listed in docs/follow-ups/b2-followups.md orphan fields.

    // Metadata grouped (00335:165 / 483-706).
    if (
      has('title') ||
      has('description') ||
      has('cost') ||
      has('tags') ||
      has('watchers')
    ) {
      const metadata: Record<string, unknown> = {};
      if (has('title')) metadata.title = fields.title;
      if (has('description')) metadata.description = fields.description;
      if (has('cost')) metadata.cost = fields.cost;
      if (has('tags')) metadata.tags = fields.tags;
      if (has('watchers')) metadata.watchers = fields.watchers;
      patches.metadata = metadata;
    }

    return patches;
  }

  /**
   * Replace `{{ticket.field}}` style tokens with values from `vars`.
   * Supports nested paths (`{{ticket.nested.field}}`) and context (`{{context.key}}`).
   */
  private substituteTemplate(tpl: string, vars: Record<string, unknown>): string {
    if (!tpl) return tpl;
    return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
      const parts = path.split('.');
      let cur: unknown = vars;
      for (const p of parts) {
        if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
          cur = (cur as Record<string, unknown>)[p];
        } else {
          return '';
        }
      }
      return cur == null ? '' : typeof cur === 'object' ? JSON.stringify(cur) : String(cur);
    });
  }

  /**
   * Resume a waiting workflow instance.
   *
   * Cross-tenant FK leak fix (codex post-fix review 2026-05-08): the prior
   * implementation accepted only `instanceId` and relied on ambient
   * `TenantContext` if present, falling back to `instance.tenant_id` when
   * unset. That fallback branch existed for a hypothetical caller that has
   * no TenantContext — but the only real caller is the WorkflowController,
   * which always runs inside an authed-request TenantContext. Drop the
   * fallback: require `tenantId` explicitly. Forces every caller to prove
   * which tenant it's resuming as.
   *
   * The instance lookup filters by tenant_id; a cross-tenant resume attempt
   * (any instanceId not in the caller's tenant) returns null and exits with
   * no side effect.
   */
  async resume(instanceId: string, tenantId: string, edgeCondition?: string) {
    // Codex IMPORTANT 1 remediation (2026-05-12): atomic claim as the
    // first DB write. The prior implementation read `status='waiting'`,
    // then later wrote `status='active'` without a claim guard. Two
    // concurrent handler invocations on sibling links of the same
    // parent could both pass the read check, both advance, both write
    // audit events. Phase 1.A's per-row claim of workflow_instance_links
    // makes that race REACHABLE (each handler picks a sibling link, both
    // see the parent as `waiting`).
    //
    // Fix: the status='waiting' → status='active' transition is now the
    // FIRST write — `UPDATE ... WHERE status='waiting' RETURNING ...`
    // is atomic, so exactly one caller observes data!=null. The losers
    // observe data=null and no-op (idempotent — covers the cancelled /
    // completed transitions as well as another worker beating us).
    // Phase 1.5 sub-step 6.A, Change 3 — polymorphize the claim's
    // RETURNING to include entity_kind + all polymorphic id columns. The
    // `advance()` signature still threads `ticketId: string` (the full
    // rename is the deferred Phase 1.B.x slice) — for Phase 1.5 we just
    // resolve the polymorphic id and pass it as the legacy parameter.
    const claimRes = await this.supabase.admin
      .from('workflow_instances')
      .update({ status: 'active', waiting_for: null })
      .eq('id', instanceId)
      .eq('tenant_id', tenantId)
      .eq('status', 'waiting')
      .select(
        'id, workflow_definition_id, current_node_id, entity_kind, case_id, work_order_id, booking_id, ticket_id',
      )
      .maybeSingle();

    if (!claimRes.data) {
      // Idempotent no-op: another worker already claimed it, OR the
      // instance was cancelled/completed between caller's request and
      // our claim, OR the instance doesn't exist / belongs to a different
      // tenant. All four cases collapse to "do nothing".
      return;
    }
    const instance = claimRes.data as {
      id: string;
      workflow_definition_id: string;
      current_node_id: string;
      entity_kind: WorkflowEntityKind | null;
      case_id: string | null;
      work_order_id: string | null;
      booking_id: string | null;
      ticket_id: string | null;
    };

    // Polymorphic entityId resolution — pick the right column off the row
    // based on entity_kind. legacy default is ticket_id (pre-00369 rows).
    // For 'case' kind, prefer case_id (post-00238 contract) over ticket_id.
    const resumedEntityKind: WorkflowEntityKind = instance.entity_kind ?? 'case';
    const resumedEntityId: string | null =
      resumedEntityKind === 'case'
        ? (instance.case_id ?? instance.ticket_id)
        : resumedEntityKind === 'work_order'
          ? instance.work_order_id
          : resumedEntityKind === 'booking'
            ? instance.booking_id
            : instance.ticket_id;
    if (!resumedEntityId) {
      throw AppErrors.server('workflow.advance_failed', {
        detail: `missing polymorphic entityId for instance ${instanceId} (kind=${resumedEntityKind})`,
      });
    }

    // Two-step read for the definition: the PostgREST embed
    // `definition:workflow_definitions(*)` on workflow_instances would
    // FK-traverse server-side without an independent tenant filter — a
    // foreign workflow_definition_id (FK-smuggle) would load a foreign
    // graph and execute it. Audit finding: separate query so the second
    // SELECT can be tenant-filtered explicitly.
    const { data: definition } = await this.supabase.admin
      .from('workflow_definitions')
      .select('*')
      .eq('id', instance.workflow_definition_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!definition) return;

    const graph = (definition as { graph_definition: unknown }).graph_definition as WorkflowGraph;
    // Reuse ambient TenantContext if it matches; otherwise resolve full
    // TenantInfo (slug + tier) from `tenants` so downstream audit/billing
    // reads see real values.
    const ambient = TenantContext.currentOrNull();
    let tenantInfo: { id: string; slug: string; tier: 'standard' | 'enterprise' };
    if (ambient && ambient.id === tenantId) {
      tenantInfo = ambient;
    } else {
      const { data: tenantRow } = await this.supabase.admin
        .from('tenants')
        .select('id, slug, tier')
        .eq('id', tenantId)
        .maybeSingle();
      if (!tenantRow) return;
      tenantInfo = tenantRow as { id: string; slug: string; tier: 'standard' | 'enterprise' };
    }

    await TenantContext.run(tenantInfo, async () => {
      await this.emit(instanceId, 'instance_resumed', { payload: { edge_condition: edgeCondition ?? null } });
      await this.advance(instanceId, graph, instance.current_node_id, resumedEntityId, edgeCondition);
    });
  }

  /**
   * Phase 1.C — public emit alias for the wait-sweeper cron.
   *
   * The private `emit()` is the canonical write path for
   * workflow_instance_events; the cron has no other reason to know
   * about the audit table's shape. Exposing a narrow named method
   * (vs. unprivating `emit`) keeps the engine's authorial surface
   * unchanged. `TenantContext.run(...)` must be active at the call
   * site — same precondition as the internal emit.
   *
   * Spec: docs/superpowers/specs/2026-05-12-universal-workflow-architecture-design.md §3.5.
   */
  async emitForCron(
    instanceId: string,
    event_type: string,
    fields: { node_id?: string; node_type?: string; decision?: string; payload?: Record<string, unknown> } = {},
  ): Promise<void> {
    await this.emit(instanceId, event_type, fields);
  }

  private async emit(
    instanceId: string,
    event_type: string,
    fields: { node_id?: string; node_type?: string; decision?: string; payload?: Record<string, unknown> } = {},
    ctx?: WorkflowRunContext,
  ) {
    if (ctx?.dryRun) {
      ctx.events.push({ event_type, ...fields });
      return;
    }
    try {
      const tenant = TenantContext.current();
      await this.supabase.admin.from('workflow_instance_events').insert({
        tenant_id: tenant.id,
        workflow_instance_id: instanceId,
        event_type,
        node_id: fields.node_id ?? null,
        node_type: fields.node_type ?? null,
        decision: fields.decision ?? null,
        payload: fields.payload ?? {},
      });
    } catch (err) {
      // Best-effort — workflow engine continues if event log is unavailable.
      // Surface failures to logs so future event_type / CHECK-constraint
      // drift doesn't silently swallow audit rows (cf. node_failed regression
      // shipped in B.2.A.Step 8 → fixed by 00366).
      console.warn('[workflow] workflow_instance_events insert failed', { event_type, error: err });
    }
  }
}
