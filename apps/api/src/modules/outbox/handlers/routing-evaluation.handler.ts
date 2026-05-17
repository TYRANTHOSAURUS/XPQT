import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../../common/supabase/supabase.service';
import { RoutingService } from '../../routing/routing.service';
import type { AssignmentTarget, ResolverContext } from '../../routing/resolver.types';
import { DeadLetterError } from '../dead-letter.error';
import { OutboxHandler, type OutboxEventHandler } from '../outbox-handler.decorator';
import type { OutboxEvent } from '../outbox.types';

/**
 * RoutingEvaluationHandler — drains `routing.evaluation_required` outbox events.
 *
 * Spec: docs/follow-ups/b2-survey-and-design.md §3.9.3 lines 2783-2786 +
 *       §3.10 step 10 (emitter — reclassify_ticket) + §3.9.2 (routing_status).
 *
 * ── Behavior ─────────────────────────────────────────────────────────────
 *
 *   1. Tenant smuggling defense (event.tenant_id vs payload.tenant_id).
 *   2. Re-read tickets row for the routing context (request_type_id,
 *      location_id, asset_id, priority, current assignees). Hard-delete
 *      between emit + fire → terminal no-op.
 *   3. Compute effective routing context including the request_type's
 *      `domain` field (the legacy ResolverContext shape; populated for
 *      compat with the v1 evaluator paths).
 *   4. Call `RoutingService.evaluate(ctx)`. The evaluator runs sync in
 *      TS — no DB writes.
 *   5. If the resolver returns a target AND it differs from the current
 *      assignee tuple → call `set_entity_assignment` RPC with a stable
 *      idempotency key derived from the OUTBOX EVENT ID (so a replay
 *      collapses to the same command_operations row).
 *   6. Always insert a `routing_decisions` row capturing the trace
 *      (including `unassigned` outcomes — spec line 2786 "valid
 *      `unassigned` outcome (v5 / I4); `'failed'` only for genuine errors").
 *   7. `tickets.routing_status` clear-to-`'idle'` is folded INTO the
 *      `set_entity_assignment` RPC via the opt-in `clear_routing_status`
 *      payload flag (v3, audit-02 P1-2) — atomic with the assignment, no
 *      separate post-RPC raw UPDATE. The RPC's v3 no-op fast path still
 *      clears routing_status when the flag is set, so a re-evaluation
 *      that re-picks the current assignee can't leave it pinned at
 *      'pending'. `'failed'` is still set out-of-band on resolver throws
 *      or RPC errors (markRoutingFailure) — those paths skip the RPC.
 *
 * ── Case-only contract ───────────────────────────────────────────────────
 *
 * This handler is case-only by construction. The only producers of
 * `routing.evaluation_required` are the `reclassify_ticket` RPC
 * (00354:544-556) and the `grant_ticket_approval` RPC (00358:324-341) —
 * both emit aggregate_type='ticket' with a ticket_id payload. There is NO
 * work_order producer (confirmed: no TS `outbox.emit` of this type, no
 * other SQL emitter). A work_order id would already fail loud inside
 * `set_entity_assignment` (`set_entity_assignment.not_found` — the RPC
 * SELECTs from `public.tickets` for kind='case'). WO routing-evaluation
 * is an explicit FUTURE GAP, not handled here; no speculative WO branch
 * is built (there is nothing to branch on).
 *
 * ── Idempotency ──────────────────────────────────────────────────────────
 *
 * Two layers:
 *   a) The `set_entity_assignment` RPC has its own `command_operations`
 *      gate keyed on (tenant_id, idempotency_key). We use
 *      `routing-evaluation:<event_id>` so a replay collapses to the cached
 *      RPC result — no double-assignment.
 *   b) Routing-decision INSERTs use the event_id in the context payload so
 *      ops triage can identify "this row was written by event X". There is
 *      no unique constraint on routing_decisions — append-only audit is
 *      the intended shape. Duplicates from a replay are tolerable; they
 *      surface as two trace rows pointing at the same event_id which is
 *      a debuggable state, not a corruption.
 *
 * ── Cross-tenant defense ─────────────────────────────────────────────────
 *
 * Every read filters by `event.tenant_id`. Payload tenant_id mismatch
 * dead-letters before any DB call.
 */

export interface RoutingEvaluationRequiredPayload {
  /** Tenant — duplicated from event.tenant_id for handler convenience + defense-in-depth. */
  tenant_id: string;
  /** Case (tickets) row id. */
  ticket_id: string;
}

const ROUTING_EVALUATION_IDEMPOTENCY_KEY_PREFIX = 'routing-evaluation';

function buildRoutingEvaluationIdempotencyKey(eventId: string): string {
  return `${ROUTING_EVALUATION_IDEMPOTENCY_KEY_PREFIX}:${eventId}`;
}

interface TicketContextRow {
  id: string;
  tenant_id: string;
  ticket_type_id: string | null;
  location_id: string | null;
  asset_id: string | null;
  priority: string | null;
  assigned_team_id: string | null;
  assigned_user_id: string | null;
  assigned_vendor_id: string | null;
  routing_status: string;
}

@Injectable()
@OutboxHandler('routing.evaluation_required', { version: 1 })
export class RoutingEvaluationHandler
  implements OutboxEventHandler<RoutingEvaluationRequiredPayload>
{
  private readonly log = new Logger(RoutingEvaluationHandler.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly routingService: RoutingService,
  ) {}

  async handle(event: OutboxEvent<RoutingEvaluationRequiredPayload>): Promise<void> {
    const { tenant_id, ticket_id } = event.payload;

    // ── 1. Tenant smuggling defense ──────────────────────────────────────
    if (tenant_id !== event.tenant_id) {
      throw new DeadLetterError(
        `routing_evaluation.tenant_mismatch: event.tenant_id=${event.tenant_id} payload.tenant_id=${tenant_id}`,
      );
    }

    // ── 2. Re-read the ticket for current routing context ───────────────
    const ticketRes = await this.supabase.admin
      .from('tickets')
      .select(
        'id, tenant_id, ticket_type_id, location_id, asset_id, priority, ' +
          'assigned_team_id, assigned_user_id, assigned_vendor_id, routing_status',
      )
      .eq('id', ticket_id)
      .eq('tenant_id', event.tenant_id)
      .maybeSingle();

    if (ticketRes.error) {
      throw new Error(`routing_evaluation.ticket_read_failed: ${ticketRes.error.message}`);
    }
    if (!ticketRes.data) {
      // Hard-deleted between emit + fire. Terminal per v9 / P-I5.
      this.log.log(`ticket_not_found ticket=${ticket_id} event=${event.id}`);
      return;
    }
    const ticket = ticketRes.data as unknown as TicketContextRow;

    // ── 3. Compose the resolver context ─────────────────────────────────
    //
    // The v1 ResolverContext also carries `domain` (free-text). Load it
    // from request_types so the v1 path still has the discriminator;
    // v2 path looks it up via the domain registry. Either way, missing
    // request_type_id means no routing → write an `unassigned` decision.
    let domain: string | null = null;
    if (ticket.ticket_type_id) {
      const rtRes = await this.supabase.admin
        .from('request_types')
        .select('domain')
        .eq('id', ticket.ticket_type_id)
        .eq('tenant_id', event.tenant_id)
        .maybeSingle();
      if (rtRes.error) {
        throw new Error(
          `routing_evaluation.request_type_read_failed: ${rtRes.error.message}`,
        );
      }
      domain = (rtRes.data as { domain: string | null } | null)?.domain ?? null;
    }

    const context: ResolverContext = {
      tenant_id: event.tenant_id,
      ticket_id: ticket.id,
      request_type_id: ticket.ticket_type_id,
      domain,
      priority: ticket.priority,
      asset_id: ticket.asset_id,
      location_id: ticket.location_id,
    };

    // ── 4. Evaluate (TS, no DB writes) ──────────────────────────────────
    //
    // The outbox worker (outbox.worker.ts:217) already wraps handler.handle
    // in TenantContext.run, so downstream services that call
    // TenantContext.current() see the right tenant without re-wrapping here.
    let evaluation;
    try {
      evaluation = await this.routingService.evaluate(context);
    } catch (err) {
      // Resolver crash → 'failed' breadcrumb. NOT dead-letter; the next
      // reclassify / routing-trigger re-emits an event so ops can retry
      // after fixing the rule definition / routing matrix.
      const message = err instanceof Error ? err.message : String(err);
      await this.markRoutingFailure(event.tenant_id, ticket_id, message, event.id);
      this.log.warn(
        `evaluation_failed ticket=${ticket_id} event=${event.id}: ${message}`,
      );
      // Return normally — terminal-but-recorded. The outbox worker marks
      // processed_at; ops sees `routing_status='failed'` on the ticket.
      return;
    }

    // ── 5. set_entity_assignment — ALWAYS called (audit-02 P1-2) ────────
    //
    // The RPC is now invoked on EVERY non-failure path so the
    // routing_status='idle' / routing_failure_reason=null clear is
    // ATOMIC with (and idempotent like) the assignment write — folded
    // into the RPC's single tx via the v3 opt-in `clear_routing_status`
    // flag, never a separate post-RPC raw UPDATE a crash could skip.
    //
    // Two payload shapes:
    //   * target found AND differs from current → include all three
    //     assigned_*_id keys (explicit null = "clear that axis") so the
    //     RPC applies the new assignment. The no-op shortcut won't fire
    //     (assignees differ) so the §10 UPDATE runs and also clears
    //     routing_status.
    //   * unassigned (target === null) OR target already matches current
    //     → OMIT the assigned_*_id keys entirely. key-absent = "no
    //     change" in the RPC (00327:189-191), so the existing assignment
    //     is preserved (an `unassigned` resolver outcome must NOT wipe a
    //     standing assignee — v5/I4). The v3 no-op fast path is SKIPPED
    //     because clear_routing_status is set, so the §10 UPDATE still
    //     runs and clears routing_status — atomic, idempotent, crash-safe.
    //
    // No `reason` field on either shape — passing one would trigger
    // set_entity_assignment's manual-reassign audit branch and write a
    // routing_decisions row classified as `manual_reassign`. We want only
    // the resolver-audit row written below at step 6, classified by
    // `evaluation.chosen_by` (rule / asset_override / location_team /
    // etc.). codex-S11-I2 (2026-05-11).
    const target: AssignmentTarget | null = evaluation.target;
    const applyAssignment = target !== null && !this.targetMatchesCurrent(target, ticket);
    const payload: Record<string, unknown> = { clear_routing_status: true };
    if (applyAssignment && target !== null) {
      payload.assigned_team_id = target.kind === 'team' ? target.team_id : null;
      payload.assigned_user_id = target.kind === 'user' ? target.user_id : null;
      payload.assigned_vendor_id = target.kind === 'vendor' ? target.vendor_id : null;
    }

    const idempotencyKey = buildRoutingEvaluationIdempotencyKey(event.id);
    const rpcRes = await this.supabase.admin.rpc('set_entity_assignment', {
      p_entity_id: ticket_id,
      // Case-only by construction — see the class-doc "Case-only contract"
      // note. A WO id would fail loud as set_entity_assignment.not_found
      // (the RPC SELECTs from public.tickets for kind='case').
      p_entity_kind: 'case',
      p_tenant_id: event.tenant_id,
      // The outbox worker is the system actor — null actor lets the
      // RPC's actor_person_id lookup fall through cleanly without raising.
      p_actor_user_id: null,
      p_idempotency_key: idempotencyKey,
      p_payload: payload,
    });

    if (rpcRes.error) {
      // RPC error → record routing failure, return. The downstream RPC
      // has its own classify-and-dead-letter logic; here we just want the
      // ticket to show `routing_status='failed'` until ops re-triggers.
      await this.markRoutingFailure(
        event.tenant_id,
        ticket_id,
        rpcRes.error.message,
        event.id,
      );
      this.log.warn(
        `assignment_failed ticket=${ticket_id} event=${event.id}: ${rpcRes.error.message}`,
      );
      return;
    }
    const assignmentApplied = applyAssignment;

    // ── 6. Always write the routing_decisions row (audit trail) ─────────
    //
    // Spec line 2762-2764: "the resolver should re-run to record the
    // breadcrumb". Even when target == current, we record the decision
    // so the audit feed shows the evaluation happened.
    //
    // codex-S11-I1 (2026-05-11): inspect .error explicitly. A silent
    // failure here leaves the ticket flapping in routing_status='pending'
    // with no audit row and no failure breadcrumb — exactly the failure
    // mode the outbox worker's retry contract exists to surface.
    const decisionRes = await this.supabase.admin.from('routing_decisions').insert({
      tenant_id: event.tenant_id,
      ticket_id,
      // P2-2 tail (audit-02): set the polymorphic discriminator EXPLICITLY
      // at this site instead of relying on the 00232 derive trigger. This
      // handler is case-only by construction (see class-doc), so
      // entity_kind='case' + case_id=ticket_id are statically correct —
      // mirrors how set_entity_assignment sets them inside the RPC
      // (00327:262-271) and the reassign sites (ticket.service.ts:1466).
      entity_kind: 'case',
      case_id: ticket_id,
      strategy: evaluation.strategy,
      chosen_team_id: target?.kind === 'team' ? target.team_id : null,
      chosen_user_id: target?.kind === 'user' ? target.user_id : null,
      chosen_vendor_id: target?.kind === 'vendor' ? target.vendor_id : null,
      chosen_by: evaluation.chosen_by,
      rule_id: evaluation.rule_id,
      trace: evaluation.trace,
      context: {
        request_type_id: context.request_type_id,
        domain: context.domain,
        priority: context.priority,
        asset_id: context.asset_id,
        location_id: context.location_id,
        outbox_event_id: event.id,
      },
    });
    if (decisionRes.error) {
      // The assignment write at step 5 already committed. Surface the
      // audit-row failure so ops can investigate; the outbox worker's
      // retry will re-attempt the audit insert on next tick.
      throw new Error(
        `routing.evaluation_required.audit_insert_failed event=${event.id}: ${decisionRes.error.message}`,
      );
    }

    // ── 7. routing_status clear — folded into the RPC (audit-02 P1-2) ───
    //
    // No separate post-RPC raw UPDATE. tickets.routing_status='idle' /
    // routing_failure_reason=null was cleared ATOMICALLY inside the §5
    // set_entity_assignment call via the v3 `clear_routing_status` flag
    // — including on the no-op / unassigned / target-matches-current
    // shapes (the v3 fast path is skipped when the flag is set). A crash
    // can no longer leave the ticket assigned with routing_status pinned
    // at 'pending'.

    this.log.log(
      `evaluated ticket=${ticket_id} chosen_by=${evaluation.chosen_by} ` +
        `target=${target ? target.kind : 'null'} assignment_applied=${assignmentApplied} event=${event.id}`,
    );
  }

  /** Does the resolver target match the ticket's current assignment tuple? */
  private targetMatchesCurrent(target: AssignmentTarget, ticket: TicketContextRow): boolean {
    if (target.kind === 'team') {
      return (
        ticket.assigned_team_id === target.team_id &&
        ticket.assigned_user_id === null &&
        ticket.assigned_vendor_id === null
      );
    }
    if (target.kind === 'user') {
      return (
        ticket.assigned_user_id === target.user_id &&
        ticket.assigned_team_id === null &&
        ticket.assigned_vendor_id === null
      );
    }
    return (
      ticket.assigned_vendor_id === target.vendor_id &&
      ticket.assigned_team_id === null &&
      ticket.assigned_user_id === null
    );
  }

  /**
   * Record `routing_status='failed'` + a ticket_activities breadcrumb
   * + a routing_decisions audit row carrying the failure reason. Best-
   * effort: any insert error is logged but doesn't propagate (we don't
   * want a failure-recording-failure to retry the whole event).
   *
   * Step11 self-review F-CRIT-2: the routing_decisions audit row was
   * documented in the doc comment above (lines 297-300) but never
   * implemented — the pre-fix failure path only wrote tickets +
   * ticket_activities, leaving the routing_decisions audit feed without
   * a breadcrumb pointing back to the failed event. tenant_id is
   * included to keep the cross-tenant defense intact (memory:
   * feedback_tenant_id_ultimate_rule).
   */
  private async markRoutingFailure(
    tenantId: string,
    ticketId: string,
    reason: string,
    eventId: string,
  ): Promise<void> {
    const truncated = reason.length > 500 ? `${reason.slice(0, 497)}...` : reason;

    const updateRes = await this.supabase.admin
      .from('tickets')
      .update({
        routing_status: 'failed',
        routing_failure_reason: truncated,
      })
      .eq('id', ticketId)
      .eq('tenant_id', tenantId);
    if (updateRes.error) {
      this.log.warn(
        `markRoutingFailure: tickets update failed event=${eventId}: ${updateRes.error.message}`,
      );
    }

    const actRes = await this.supabase.admin.from('ticket_activities').insert({
      tenant_id: tenantId,
      ticket_id: ticketId,
      activity_type: 'system_event',
      visibility: 'system',
      metadata: {
        event: 'routing_evaluation_failed',
        reason: truncated,
        outbox_event_id: eventId,
      },
    });
    if (actRes.error) {
      this.log.warn(
        `markRoutingFailure: ticket_activities insert failed event=${eventId}: ${actRes.error.message}`,
      );
    }

    // routing_decisions audit row. Mirrors the success-path insert shape.
    // P2-2 tail (audit-02): entity_kind='case' + case_id set EXPLICITLY
    // (handler is case-only — see class-doc) rather than via the 00232
    // derive trigger, matching the success path above. rule_id null since
    // no rule fired. chosen_by='auto_routing_failed' is the failure
    // sentinel — ops can filter routing_decisions on this value to
    // surface unresolved routing problems. trace carries the truncated
    // reason for forensics.
    const decisionRes = await this.supabase.admin.from('routing_decisions').insert({
      tenant_id: tenantId,
      ticket_id: ticketId,
      entity_kind: 'case',
      case_id: ticketId,
      strategy: 'failed',
      chosen_team_id: null,
      chosen_user_id: null,
      chosen_vendor_id: null,
      chosen_by: 'auto_routing_failed',
      rule_id: null,
      trace: [
        {
          step: 'evaluation_failed',
          matched: false,
          reason: truncated,
          target: null,
        },
      ],
      context: {
        outbox_event_id: eventId,
        failure_reason: truncated,
      },
    });
    if (decisionRes.error) {
      this.log.warn(
        `markRoutingFailure: routing_decisions insert failed event=${eventId}: ${decisionRes.error.message}`,
      );
    }
  }
}
