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
 *      assignee tuple → call `set_entity_assignment` RPC (00327 v2) with
 *      a stable idempotency key derived from the OUTBOX EVENT ID (so a
 *      replay collapses to the same command_operations row).
 *   6. Always insert a `routing_decisions` row capturing the trace
 *      (including `unassigned` outcomes — spec line 2786 "valid
 *      `unassigned` outcome (v5 / I4); `'failed'` only for genuine errors").
 *   7. Set `tickets.routing_status='idle'` on success (target OR
 *      unassigned). Set `'failed'` only on resolver throws or RPC errors.
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

    // ── 5. Optional set_entity_assignment when the target differs ───────
    //
    // Skip the assignment call if the resolver produced no target
    // (unassigned). Skip if the target matches current assignees exactly
    // — the RPC's no-op fast path would handle it but saving the HTTP
    // round-trip is cheap.
    const target: AssignmentTarget | null = evaluation.target;
    let assignmentApplied = false;
    if (target !== null && !this.targetMatchesCurrent(target, ticket)) {
      const payload: Record<string, unknown> = {
        // Set all three explicitly so the RPC's no-op-fast-path semantics
        // are deterministic — `assigned_team_id=null` means "clear",
        // omitted key means "no change". We want a clean overwrite.
        assigned_team_id: target.kind === 'team' ? target.team_id : null,
        assigned_user_id: target.kind === 'user' ? target.user_id : null,
        assigned_vendor_id: target.kind === 'vendor' ? target.vendor_id : null,
        // No `reason` field — passing one would trigger
        // set_entity_assignment's manual-reassign audit branch
        // (00327_v2:258) and write a routing_decisions row classified
        // as `manual_reassign`. We want only the resolver-audit row
        // written below at step 6, classified by `evaluation.chosen_by`
        // (rule / asset_override / location_team / etc.). codex-S11-I2
        // (2026-05-11).
      };

      const idempotencyKey = buildRoutingEvaluationIdempotencyKey(event.id);
      const rpcRes = await this.supabase.admin.rpc('set_entity_assignment', {
        p_entity_id: ticket_id,
        p_entity_kind: 'case',
        p_tenant_id: event.tenant_id,
        // The outbox worker is the system actor — null actor lets the
        // RPC's actor_person_id lookup (00327:291-299) fall through
        // cleanly without raising.
        p_actor_user_id: null,
        p_idempotency_key: idempotencyKey,
        p_payload: payload,
      });

      if (rpcRes.error) {
        // RPC error → record routing failure, return. The downstream
        // RPC has its own classify-and-dead-letter logic; here we just
        // want the ticket to show `routing_status='failed'` until ops
        // re-triggers routing.
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
      assignmentApplied = true;
    }

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
      // The assignment write at step 5 already committed (if it ran).
      // Surface the audit-row failure so ops can investigate; the outbox
      // worker's retry will re-attempt the audit insert on next tick.
      throw new Error(
        `routing.evaluation_required.audit_insert_failed event=${event.id}: ${decisionRes.error.message}`,
      );
    }

    // ── 7. Clear routing_status to 'idle' ──────────────────────────────
    //
    // Both target-found and unassigned-outcome converge to `idle`
    // (v5 / I4). `failed` is reserved for the catch-paths above.
    //
    // codex-S11-I1: inspect .error explicitly. A silent failure leaves
    // the ticket pinned in routing_status='pending' even though the
    // assignment + audit-row commits succeeded.
    const tStatusRes = await this.supabase.admin
      .from('tickets')
      .update({
        routing_status: 'idle',
        routing_failure_reason: null,
      })
      .eq('id', ticket_id)
      .eq('tenant_id', event.tenant_id);
    if (tStatusRes.error) {
      throw new Error(
        `routing.evaluation_required.status_clear_failed event=${event.id}: ${tStatusRes.error.message}`,
      );
    }

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
