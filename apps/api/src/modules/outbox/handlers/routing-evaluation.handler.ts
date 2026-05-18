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
 *   2. Fail-closed entity-kind guard. This handler is case-only by
 *      CONTRACT: all 5 producers of `routing.evaluation_required` are
 *      case/ticket-only (migrations 00354–00358). There is no work_order
 *      producer. If entity_kind is somehow non-case, dead-letter immediately
 *      rather than silently mis-handle (per audit02 P1-2 F11).
 *   3. Re-read tickets row for the routing context (request_type_id,
 *      location_id, asset_id, priority, current assignees). Hard-delete
 *      between emit + fire → terminal no-op.
 *   4. Compute effective routing context including the request_type's
 *      `domain` field (the legacy ResolverContext shape; populated for
 *      compat with the v1 evaluator paths).
 *   5. Call `RoutingService.evaluate(ctx)`. The evaluator runs sync in
 *      TS — no DB writes.
 *   6. Call `set_entity_assignment` RPC (00416 v3) with a stable
 *      idempotency key derived from the OUTBOX EVENT ID (so a replay
 *      collapses to the same command_operations row), ALWAYS passing:
 *        - `p_payload.clear_routing_status: 'true'` — v3 resets
 *          routing_status='idle' + routing_failure_reason=null inside
 *          the SAME PG transaction as the assignment write. The prior
 *          second raw `.from('tickets').update({routing_status})` write
 *          OUTSIDE the RPC's tx (audit02 P1-2) is structurally eliminated.
 *        - `p_payload.decision: {strategy,chosen_by,rule_id,trace,context}` —
 *          v3 writes the `routing_decisions` row atomically using this
 *          provenance. The prior standalone TS routing_decisions.insert
 *          (audit02 P1-2) is structurally eliminated.
 *      Assignment keys are included only when the target differs from
 *      current; for unassigned/matches-current outcomes the RPC is called
 *      with only the two directives (v3's no-op fast path does NOT fire
 *      when either directive is present — 00416:440-442 F17).
 *   7. Set `tickets.routing_status='failed'` ONLY on resolver throws or
 *      RPC errors. `'idle'` is handled by v3 via `clear_routing_status`.
 *
 * audit02 P1-2 (2026-05-18): prior handler had THREE cross-tx bugs:
 *   (a) routing_status clear was a SECOND raw `.from('tickets').update`
 *       OUTSIDE the RPC's tx — a crash between left routing_status stuck
 *       'pending'. Fixed: folded into v3 via `p_payload.clear_routing_status`.
 *   (b) `p_entity_kind:'case'` was correct by contract (F11) but lacked a
 *       fail-closed guard. Fixed: DeadLetterError if entity_kind non-case.
 *   (c) `routing_decisions` insert was a standalone TS write SEPARATE from
 *       the assignment RPC. Fixed: v3 owns it atomically via `p_payload.decision`.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────
 *
 * The `set_entity_assignment` RPC has its own `command_operations` gate
 * keyed on (tenant_id, idempotency_key). We use
 * `routing-evaluation:<event_id>` so a replay collapses to the cached
 * RPC result — no double-assignment, no double-routing_decisions-insert,
 * no double-routing_status-clear. All three writes are inside the same
 * atomic PG tx covered by the same idempotency gate (audit02 P1-2).
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

    // ── 2. Fail-closed entity-kind guard (audit02 P1-2 F11) ─────────────
    //
    // This handler is case-only BY CONTRACT. All 5 producers of
    // `routing.evaluation_required` are case/ticket-only (migrations
    // 00354–00358). There is NO work_order producer. A non-case entity_kind
    // in the payload is a data-contract violation — not a transient error —
    // so we dead-letter immediately rather than silently mis-handle.
    // WO re-routing is an explicitly-deferred separate future event (see
    // docs/assignments-routing-fulfillment.md §28).
    const entityKind = (event.payload as unknown as Record<string, unknown>).entity_kind;
    if (entityKind !== undefined && entityKind !== 'case') {
      throw new DeadLetterError(
        `routing_evaluation.invalid_entity_kind: expected 'case' (contract: producers 00354-00358 are case-only); got '${String(entityKind)}' event=${event.id}`,
      );
    }

    // ── 3. Re-read the ticket for current routing context ───────────────
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

    // ── 4. Compose the resolver context ─────────────────────────────────
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

    // ── 5. Evaluate (TS, no DB writes) ──────────────────────────────────
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

    // ── 6. Always call set_entity_assignment (audit02 P1-2) ─────────────
    //
    // v3 (00416) handles ALL three of the following atomically in ONE PG tx:
    //   (a) Assignment column update — only when target differs from current.
    //       Include the three assignment keys only when target is non-null
    //       AND differs; omit them otherwise (v3 key-absent = "no change").
    //   (b) routing_status='idle' + routing_failure_reason=null — via
    //       `p_payload.clear_routing_status:'true'`. The prior second raw
    //       `.from('tickets').update` OUTSIDE the RPC's tx is structurally
    //       eliminated; a crash between assignment and status-clear is now
    //       impossible (audit02 P1-2).
    //   (c) routing_decisions audit row — via `p_payload.decision` carrying
    //       strategy/chosen_by/rule_id/trace/context from the evaluation.
    //       The prior standalone TS routing_decisions.insert is eliminated;
    //       v3 owns it atomically (audit02 P1-2).
    //
    // The evaluation-result → decision mapping is the IDENTITY: RoutingEvaluation
    // .strategy is FulfillmentShape | 'rule' (routing.service.ts:18 /
    // resolver.types.ts:1) = {asset,location,fixed,auto,rule} which is BYTE-
    // IDENTICAL to v3's strategy allowlist (00416:356). RoutingEvaluation
    // .chosen_by is the ChosenBy union (resolver.types.ts:8-27) which is BYTE-
    // IDENTICAL to v3's chosen_by allowlist (00416:366-371). No normalization
    // required — a non-identity map would be the bug. context mirrors
    // RoutingService.recordDecision (routing.service.ts:77-83) + adds
    // outbox_event_id for replay tracing. Mirrors Slice C idiom
    // (ticket.service.ts:1380-1392).
    //
    // v3 no-op fast path (00416:436-442 F17) is NOT taken when either
    // clear_routing_status or decision is present — so the RPC always commits
    // the routing_status clear + routing_decisions row even when the assignee
    // tuple is unchanged (unassigned, matches-current). This is the correct
    // behavior: every evaluation fires a breadcrumb.
    //
    // No `reason` field — passing one would trigger v3's manual-reassign audit
    // branch (00416:508) and classify the routing_decisions row as
    // `manual_reassign`. We want `chosen_by=evaluation.chosen_by` (e.g. 'rule',
    // 'unassigned', etc.). codex-S11-I2 (2026-05-11).
    const target: AssignmentTarget | null = evaluation.target;
    const targetDiffers = target !== null && !this.targetMatchesCurrent(target, ticket);

    const rpcPayload: Record<string, unknown> = {
      // Assignment keys: only when the target actually differs. Omitting
      // them when target is null or matches lets v3's "key-absent = no
      // change" semantics preserve the existing assignment columns.
      ...(targetDiffers && {
        assigned_team_id: target!.kind === 'team' ? target!.team_id : null,
        assigned_user_id: target!.kind === 'user' ? target!.user_id : null,
        assigned_vendor_id: target!.kind === 'vendor' ? target!.vendor_id : null,
      }),
      // audit02 P1-2: fold routing_status clear into the RPC tx.
      clear_routing_status: 'true',
      // audit02 P1-2: v3 writes routing_decisions atomically from this.
      decision: {
        strategy: evaluation.strategy,
        chosen_by: evaluation.chosen_by,
        rule_id: evaluation.rule_id ?? null,
        // audit02 D-A02-2: carry the resolver's chosen target ids so v3.1
        // sources routing_decisions.chosen_* from the resolver DECISION,
        // not the post-write assignment columns. Identical idiom to
        // RoutingService.recordDecision (routing.service.ts:71-73): NULL
        // on the resolver-unassigned outcome (target===null). Pre-D-A02-2
        // these were omitted and v3 fell back to v_new_*=v_prev_*=the
        // stale current assignee on the assignment-preservation path.
        chosen_team_id: target?.kind === 'team' ? target.team_id : null,
        chosen_user_id: target?.kind === 'user' ? target.user_id : null,
        chosen_vendor_id: target?.kind === 'vendor' ? target.vendor_id : null,
        trace: evaluation.trace,
        context: {
          request_type_id: context.request_type_id,
          domain: context.domain,
          priority: context.priority,
          asset_id: context.asset_id,
          location_id: context.location_id,
          outbox_event_id: event.id,
        },
      },
    };

    const idempotencyKey = buildRoutingEvaluationIdempotencyKey(event.id);
    const rpcRes = await this.supabase.admin.rpc('set_entity_assignment', {
      p_entity_id: ticket_id,
      p_entity_kind: 'case',
      p_tenant_id: event.tenant_id,
      // The outbox worker is the system actor — null actor lets the
      // RPC's actor_person_id lookup (00416:550-558) fall through
      // cleanly without raising.
      p_actor_user_id: null,
      p_idempotency_key: idempotencyKey,
      p_payload: rpcPayload,
    });

    if (rpcRes.error) {
      // RPC error → record routing failure, return. The routing_status
      // clear and routing_decisions insert did NOT commit (they live in
      // the same PG tx as the assignment write). markRoutingFailure
      // writes the 'failed' status + activity breadcrumb + failure audit
      // row as best-effort — the outbox worker's retry will re-attempt
      // the whole handler on the next tick.
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

    this.log.log(
      `evaluated ticket=${ticket_id} chosen_by=${evaluation.chosen_by} ` +
        `target=${target ? target.kind : 'null'} target_differs=${targetDiffers} event=${event.id}`,
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

    // routing_decisions audit row. Mirrors the success-path insert shape
    // (entity_kind='case' derived by the 00230 polymorphic trigger from
    // ticket_id; rule_id/null since no rule fired). chosen_by =
    // 'auto_routing_failed' is the failure sentinel — ops can filter
    // routing_decisions on this value to surface unresolved routing
    // problems. trace carries the truncated reason for forensics.
    const decisionRes = await this.supabase.admin.from('routing_decisions').insert({
      tenant_id: tenantId,
      ticket_id: ticketId,
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
