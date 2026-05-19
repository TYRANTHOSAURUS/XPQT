import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../../common/db/db.service';
import { SupabaseService } from '../../../common/supabase/supabase.service';
import { probeCommandOperationSuccess } from '../../../common/command-operations-probe';
import { mapRpcErrorToAppError } from '../../../common/errors';
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
 *      'pending'. `'failed'` is set out-of-band on a resolver throw OR a
 *      TERMINAL RPC error (a registered business/validation code, incl.
 *      command_operations.payload_mismatch) — those paths skip the RPC /
 *      consume the event. On a RETRYABLE RPC error (transient infra →
 *      mapped to unknown.server_error) the handler THROWS so the outbox
 *      redelivers (audit-02 D-A02-4 — the pre-fix code returned on ALL
 *      RPC errors, terminally consuming the event even on a transient
 *      blip; a normal return ACKs the event).
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
 * Three layers:
 *   a) The `set_entity_assignment` RPC has its own authoritative
 *      WRITE-side `command_operations` gate keyed on (tenant_id,
 *      idempotency_key). We use `routing-evaluation:<event_id>` so a
 *      replay collapses to the cached RPC result — no double-assignment.
 *   a2) audit-02 D-A02-4: this handler ALSO performs the READ-side of
 *      the idempotency contract — a `command_operations` SUCCESS-probe
 *      under the SAME stable key BEFORE re-running the resolver. The
 *      handler rebuilds the assignment payload from MUTABLE routing
 *      config + ticket inputs; a redelivery after a config/input change
 *      would recompute a drifted payload → same key + different hash →
 *      `command_operations.payload_mismatch` → poisoned event. The probe
 *      short-circuits a proven-committed delivery (log + return → outbox
 *      ACK) so the poisoning recompute never runs. The RPC keeps its
 *      authoritative write-side gate (defense in depth).
 *   b) Routing-decision INSERTs carry the event_id in the context payload
 *      and use a raw `ON CONFLICT (tenant_id,
 *      (context->>'outbox_event_id'), chosen_by) WHERE context ?
 *      'outbox_event_id' DO NOTHING` matching the partial unique index
 *      `uq_routing_decisions_outbox_event` (migration 00429, audit-02
 *      Code-I1). A redelivered event no longer writes a DUPLICATE audit
 *      row — the second insert is conflict-skipped and treated as an
 *      expected idempotent replay (success on the §6 path, silent on the
 *      markRoutingFailure path). chosen_by is in the key so the success
 *      row and the 'auto_routing_failed' sentinel for the same event are
 *      distinct (different chosen_by) and don't collide. Rows without an
 *      outbox_event_id (manual reassigns, RPC-internal rows) are excluded
 *      by the partial predicate and stay append-only.
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

// codex-tertiary item-5 (NUL hardening): a U+0000 (NUL) in any string that
// reaches a `$n::jsonb` bind makes Postgres reject the cast ("unsupported
// Unicode escape \u0000" / invalid byte) — on the markRoutingFailure path the
// reason is a free-text exception message that can contain a NUL, so the
// failure-path audit insert would throw and (per the warn-only contract there)
// the routing FAILURE would go UNAUDITED. The success path's `trace` reasons
// are also free-text (TraceEntry.reason, resolver-derived) so we scrub both
// jsonb-bound objects defensively. NUL-free input (the overwhelmingly common
// case) is returned byte-for-byte identical — behaviour is unchanged for it;
// only a NUL-bearing value is altered (NUL replaced with the U+FFFD
// replacement char so the text is preserved and the audit row becomes a VALID
// row instead of a thrown/swallowed insert).
function stripNul(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.includes('\u0000') ? s.replace(/\u0000/g, '�') : s;
}

/**
 * Recursively return a structural clone of a JSON-safe value with every
 * string scrubbed of NUL via {@link stripNul}. Used immediately before
 * `JSON.stringify` for the two jsonb-bound params so a NUL anywhere in a
 * nested string (resolver trace reasons, failure reason) cannot make the
 * `::jsonb` cast fail. Non-string scalars and structure are untouched; a
 * NUL-free object produces an equivalent (deep-equal) value, so existing
 * assertions that parse the params back are unaffected.
 */
function scrubNul<T>(value: T): T {
  if (typeof value === 'string') return stripNul(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrubNul(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubNul(v);
    }
    return out as unknown as T;
  }
  return value;
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
    // audit-02 Code-I1: the routing_decisions audit inserts move to a raw
    // parameterised insert + `ON CONFLICT ... DO NOTHING` so an outbox
    // redelivery cannot write a duplicate audit row (the assignment RPC was
    // already idempotent via command_operations; only the audit row duped).
    // DbModule is @Global (see db.module.ts) so DbService is injectable here
    // with no module-import change — same provider outbox.worker.ts uses for
    // its raw-SQL outbox state-machine writes.
    private readonly db: DbService,
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
      //
      // audit-02 P1-2 (review Plan-N1): this lookup is ALSO the runtime
      // case-only enforcement point — a runnable guard, not a doc-only
      // paper tiger. `routing.evaluation_required` is produced only for
      // cases (00354 reclassify_ticket + 00358 grant_ticket_approval_v3,
      // both aggregate_type='ticket'); there is no work_order producer.
      // If a WO id ever reached here it is NOT in `public.tickets`
      // (post-1c.10c work_orders are their own table), so it lands in
      // THIS branch and terminates cleanly — BEFORE the resolver, the
      // set_entity_assignment RPC, or markRoutingFailure. The earlier
      // review concern that a WO id would corrupt data via
      // markRoutingFailure (case_id=<wo_id> + zero-row tickets.update)
      // is therefore unreachable: the tickets-membership miss gates it
      // out here. WO routing-evaluation remains an explicit future gap.
      this.log.log(`ticket_not_found ticket=${ticket_id} event=${event.id}`);
      return;
    }
    const ticket = ticketRes.data as unknown as TicketContextRow;

    const idempotencyKey = buildRoutingEvaluationIdempotencyKey(event.id);

    // ── 2b. audit-02 D-A02-4 — command_operations success-probe ─────────
    //
    // The idempotency key `routing-evaluation:<event_id>` is STABLE, but
    // on an outbox redelivery this handler RE-RUNS
    // `routingService.evaluate()` and rebuilds the payload (the
    // assigned_*_id tuple) from MUTABLE routing config + ticket inputs
    // before the RPC. If routing config / ticket inputs changed between
    // the first delivery and a redelivery, the recomputed assignment
    // differs → same key + different payload hash →
    // `command_operations.payload_mismatch` (00425:159-162) → the handler
    // errors and (pre the §5 split below) the event was poisoned.
    //
    // Probe command_operations for a `success` row under the stable key
    // BEFORE re-evaluating. If present, the first delivery's assignment +
    // routing_status clear ALL committed atomically inside v3's PG tx —
    // the event is genuinely done. Log + return normally so the outbox
    // ACKs it (it IS handled); do NOT re-evaluate, do NOT re-call the
    // RPC, do NOT re-insert the routing_decisions audit row (the §6
    // ON CONFLICT DO NOTHING already makes a redelivery audit-idempotent;
    // this probe additionally avoids the wasteful + poisoning recompute).
    // `in_progress` is NOT a short-circuit signal (a concurrent worker
    // holds the key — the worker's claim-token + the RPC's own
    // advisory-lock + write-side gate make a fresh attempt converge
    // correctly; we only skip on a proven `success`).
    const committed = await probeCommandOperationSuccess(
      this.supabase,
      event.tenant_id,
      idempotencyKey,
    );
    if (committed) {
      this.log.log(
        `already_committed (command_operations success) ticket=${ticket_id} ` +
          `event=${event.id} — skipping re-evaluate + re-RPC, ACKing`,
      );
      return;
    }

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
      // audit-02 D-A02-4 (IMPORTANT): classify the RPC error — RETRYABLE
      // vs TERMINAL — instead of unconditionally consuming the event.
      //
      // The pre-fix code unconditionally called markRoutingFailure then
      // `return`. A normal return makes the outbox mark the event
      // processed (outbox.worker.ts:218 markSuccess) — so a TRANSIENT
      // RPC/DB error (connection drop, lock/statement timeout,
      // serialization 40001/40P01, 08* connection class) terminally
      // consumed the event with routing_status='failed', and the next
      // reclassify/routing-trigger would have to re-emit a fresh event
      // for ops to recover.
      //
      // Classification reuses the project's existing RPC-error taxonomy
      // (mapRpcErrorToAppError, map-rpc-error.ts): a leading
      // `<namespace>.<specifier>` token registered in KNOWN_ERROR_CODES
      // is a business/validation error → TERMINAL (e.g.
      // validate_assignees_in_tenant.*, set_entity_assignment.not_found,
      // and command_operations.payload_mismatch). An unparseable /
      // unregistered message maps to `unknown.server_error` — the
      // transient-infra surface → RETRYABLE.
      //
      // With the §2b success-probe above, payload_mismatch-on-redelivery
      // is no longer reachable (a redelivery short-circuits on the
      // existing command_operations success), so payload_mismatch
      // correctly classifies TERMINAL here only for the genuine
      // "same key, two genuinely different payloads in the same delivery"
      // misuse — the residual surface is overwhelmingly genuine transient
      // infra → must retry, not consume.
      const mapped = mapRpcErrorToAppError(rpcRes.error);
      const isTerminal = mapped.code !== 'unknown.server_error';

      if (!isTerminal) {
        // RETRYABLE transient error. Do NOT markRoutingFailure (that
        // would flip routing_status='failed' for a recoverable blip) and
        // do NOT return (a return ACKs the event). THROW a plain Error so
        // the outbox worker takes the §4.2.2 retry transition (markRetry
        // + backoff); a non-DeadLetterError is transient by the worker's
        // contract (outbox.worker.ts:219-234 + dead-letter.error.ts).
        // Same idiom as sla-timer-repoint.handler.ts:93 (a plain throw is
        // the sanctioned transient signal; the errors:check-app-errors
        // gate forbids only raw NestJS exception classes, not
        // `throw Error`).
        this.log.warn(
          `assignment_retryable ticket=${ticket_id} event=${event.id}: ` +
            `${rpcRes.error.message} (transient → outbox will redeliver)`,
        );
        throw new Error(
          `routing_evaluation.assignment_rpc_transient: ${rpcRes.error.message}`,
        );
      }

      // TERMINAL business/validation error. The routing_status clear and
      // routing_decisions insert did NOT commit (same PG tx as the
      // assignment write). markRoutingFailure writes the 'failed' status
      // + activity breadcrumb + failure audit row best-effort, then we
      // return — the event is genuinely unrecoverable without an operator
      // fixing the rule/matrix; ops sees routing_status='failed' and a
      // re-emitted event after the fix.
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
    // codex-S11-I1 (2026-05-11): inspect failure explicitly. A silent
    // failure here leaves the ticket flapping in routing_status='pending'
    // with no audit row and no failure breadcrumb — exactly the failure
    // mode the outbox worker's retry contract exists to surface.
    //
    // audit-02 Code-I1: raw parameterised insert (NOT supabase-js) so we
    // can append an `ON CONFLICT ... DO NOTHING` whose conflict target
    // matches uq_routing_decisions_outbox_event (00429) exactly — required
    // for the partial-index inference to bind. Fully parameterised
    // ($1..$12); jsonb columns are passed as JSON strings + cast `::jsonb`.
    // No string interpolation of any value (SQL-injection safe). Column set
    // is byte-for-byte the same the prior supabase-js insert wrote.
    //
    // P2-2 tail (audit-02): entity_kind/case_id set EXPLICITLY here instead
    // of via the 00232 derive trigger. This handler is case-only by
    // construction (see class-doc), so entity_kind='case' + case_id=
    // ticket_id are statically correct — mirrors set_entity_assignment
    // (00327:262-271) and the reassign sites (ticket.service.ts:1466).
    const decisionContext = {
      request_type_id: context.request_type_id,
      domain: context.domain,
      priority: context.priority,
      asset_id: context.asset_id,
      location_id: context.location_id,
      outbox_event_id: event.id,
    };
    // Initialised to [] so the post-catch `length === 0` read is never
    // unassigned even if a future edit adds a non-throwing catch branch
    // (the current catch always throws; this is defensive — review I-1).
    let decisionRows: { id: string }[] = [];
    try {
      const decisionRes = await this.db.query<{ id: string }>(
        `insert into public.routing_decisions
           (tenant_id, ticket_id, entity_kind, case_id, strategy,
            chosen_team_id, chosen_user_id, chosen_vendor_id, chosen_by,
            rule_id, trace, context)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
         on conflict (tenant_id, (context->>'outbox_event_id'), chosen_by)
           where context ? 'outbox_event_id'
           do nothing
         returning id`,
        [
          event.tenant_id,
          ticket_id,
          'case',
          ticket_id,
          evaluation.strategy,
          target?.kind === 'team' ? target.team_id : null,
          target?.kind === 'user' ? target.user_id : null,
          target?.kind === 'vendor' ? target.vendor_id : null,
          evaluation.chosen_by,
          evaluation.rule_id,
          // codex-tertiary item-5: scrub NUL before the ::jsonb cast.
          // evaluation.trace[].reason is free-text (resolver-derived); a NUL
          // there would otherwise throw the audit insert.
          JSON.stringify(scrubNul(evaluation.trace)),
          JSON.stringify(scrubNul(decisionContext)),
        ],
      );
      decisionRows = decisionRes.rows;
    } catch (err) {
      // The assignment write at step 5 already committed. A GENUINE DB
      // error (connectivity, constraint other than the idempotency index,
      // etc.) still THROWS exactly as before so the outbox worker retries
      // and ops can investigate — behaviour preserved from the pre-fix
      // supabase-js `.error` throw path.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `routing.evaluation_required.audit_insert_failed event=${event.id}: ${message}`,
      );
    }
    if (decisionRows.length === 0) {
      // ON CONFLICT DO NOTHING returned zero rows ⇒ a routing_decisions row
      // for (tenant, this outbox event, this chosen_by) already exists: an
      // expected idempotent OUTBOX REDELIVERY of the same event. This is
      // SUCCESS, not a failure — do NOT throw, do NOT warn (a duplicate
      // delivery is the at-least-once contract working as designed). The
      // first delivery already wrote the audit row; nothing more to do.
      this.log.debug(
        `routing-decision audit insert skipped (idempotent replay) ` +
          `ticket=${ticket_id} event=${event.id} chosen_by=${evaluation.chosen_by}`,
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
    // codex-tertiary item-5 (NUL hardening): `reason` is a free-text
    // exception message (resolver crash / RPC error). A NUL in it would make
    // the failure-path routing_decisions `::jsonb` cast throw — caught
    // warn-only here — so the routing FAILURE would go UNAUDITED. Strip NUL at
    // the source so the truncated reason that feeds tickets.update,
    // ticket_activities.metadata, failureTrace[].reason and
    // failureContext.failure_reason is uniformly NUL-free and produces a VALID
    // audit row. NUL-free messages (the common case) are unaffected.
    const truncated = stripNul(
      reason.length > 500 ? `${reason.slice(0, 497)}...` : reason,
    );

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
    //
    // audit-02 Code-I1: raw parameterised insert + the SAME ON CONFLICT
    // clause as the success path so an outbox redelivery of a failure-path
    // event can't duplicate the failure breadcrumb. The conflict-target
    // key includes chosen_by, and this row's chosen_by is the distinct
    // 'auto_routing_failed' sentinel, so a failure-path replay collapses to
    // one row WITHOUT colliding with a success-path row for the same event.
    // jsonb columns passed as JSON strings + cast ::jsonb; fully
    // parameterised (SQL-injection safe).
    const failureTrace = [
      {
        step: 'evaluation_failed',
        matched: false,
        reason: truncated,
        target: null,
      },
    ];
    const failureContext = {
      outbox_event_id: eventId,
      failure_reason: truncated,
    };
    try {
      const decisionRes = await this.db.query<{ id: string }>(
        `insert into public.routing_decisions
           (tenant_id, ticket_id, entity_kind, case_id, strategy,
            chosen_team_id, chosen_user_id, chosen_vendor_id, chosen_by,
            rule_id, trace, context)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
         on conflict (tenant_id, (context->>'outbox_event_id'), chosen_by)
           where context ? 'outbox_event_id'
           do nothing
         returning id`,
        [
          tenantId,
          ticketId,
          'case',
          ticketId,
          'failed',
          null,
          null,
          null,
          'auto_routing_failed',
          null,
          JSON.stringify(failureTrace),
          JSON.stringify(failureContext),
        ],
      );
      // rows.length === 0 ⇒ ON CONFLICT DO NOTHING skipped: a failure-path
      // breadcrumb for this event already exists (expected idempotent
      // outbox redelivery). SILENT success — NOT a warn. A duplicate
      // delivery is not an error; warning here would be noise. rows.length
      // === 1 ⇒ first delivery, row written, as before.
      if (decisionRes.rows.length === 0) {
        this.log.debug(
          `markRoutingFailure: routing_decisions audit insert skipped ` +
            `(idempotent replay) event=${eventId}`,
        );
      }
    } catch (err) {
      // GENUINE DB error on a failure path. KEEP warn-only — do NOT
      // escalate to throw: this is itself the failure-recording path, and
      // a throw here would re-drive the whole event and risk wedging the
      // outbox (behaviour preserved from the pre-fix supabase-js `.error`
      // warn-only branch).
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(
        `markRoutingFailure: routing_decisions insert failed event=${eventId}: ${message}`,
      );
    }
  }
}
