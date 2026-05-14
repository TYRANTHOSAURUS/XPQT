import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { SupabaseService } from '../../../common/supabase/supabase.service';
import { UUID_RE } from '../../../common/tenant-validation';
import { WorkflowEngineService } from '../../workflow/workflow-engine.service';
import {
  BookingLifecycleEventType,
  type BookingLifecycleEventType as BookingLifecycleEventTypeT,
} from '../../reservations/event-types';
import { DeadLetterError } from '../dead-letter.error';
import { OutboxHandler, type OutboxEventHandler } from '../outbox-handler.decorator';
import type { OutboxEvent } from '../outbox.types';

/**
 * WorkflowSpawnWakeHandler — Tier 2 outbox-driven wake mechanism for the
 * Universal Workflow Architecture.
 *
 * Spec: docs/superpowers/specs/2026-05-12-universal-workflow-architecture-design.md
 *       §3.5 (Resume mechanism — Tier 2 LOCKED v2.2)
 *       §3.7 (Multi-spawn aggregation — DEFERRED from v1; ship single-spawn only)
 *
 * Producers:
 *   - `booking.created`         → 00372_create_booking_emit_lifecycle.sql
 *   - `booking.cancelled`       → 00373_delete_booking_emit_cancelled.sql
 *   - `booking.status_changed`  → reserved for Phase 2 (transition_booking_status RPC)
 *
 * ── What this handler does ──────────────────────────────────────────────
 *
 *   1. Defends the #0 invariant — payload.tenant_id must equal
 *      event.tenant_id, mismatch → DeadLetterError (mirrors
 *      booking-approval-required.handler.ts:73-77).
 *   2. Validates the booking_id payload field is a UUID, mismatch →
 *      DeadLetterError (producer contract bug, no retry).
 *   3. SELECTs candidate `workflow_instance_links` rows with the full
 *      wake-eligibility filter:
 *
 *        SELECT id, parent_instance_id, parent_node_id, on_timeout_branch,
 *               wait_for, entity_terminal_statuses, wait_timeout_at
 *          FROM workflow_instance_links
 *         WHERE tenant_id = $eventTenant
 *           AND child_entity_id = $bookingId
 *           AND resolved_at IS NULL
 *           AND spawn_mode = 'wait'
 *           AND aggregation_group_id IS NULL       -- multi-spawn aggregation deferred (§9.3)
 *           AND (wait_timeout_at IS NULL OR wait_timeout_at > now())  -- Tier 1 cron owns timeout
 *           AND wait_for IN ('entity_status', 'either')               -- workflow_terminal waited on engine status, not entity status
 *
 *      Then in JS we filter further on `entity_terminal_statuses`
 *      (must include the status the event signalled) — supabase-js can't
 *      express `<value> = ANY(text[])` ergonomically across all cases, so
 *      we keep the membership check on the client.
 *   4. For each surviving candidate: PER-ROW atomic claim:
 *
 *        UPDATE workflow_instance_links
 *           SET resolved_at = now(), resolution_kind = 'condition_met'
 *         WHERE id = $linkId
 *           AND resolved_at IS NULL
 *      RETURNING id
 *
 *      0 rows → another worker already claimed it; skip.
 *      1 row → we own the claim; proceed.
 *   5. Defense-in-depth re-asserts the parent workflow_instance.tenant_id
 *      matches the event tenant.
 *   6. Determines the resume branch (see `resolveBranch()`).
 *   7. Calls `WorkflowEngineService.resume(parent_instance_id, tenant_id, branch)`.
 *   8. ON RESUME FAILURE — UNCLAIM the row: write
 *      `resolved_at = NULL, resolution_kind = NULL` back. This is what
 *      makes the outbox retry pickup possible. Without unclaim, a
 *      transient resume failure would permanently strand the parent.
 *
 * ── What this handler does NOT do (deferred to later Phase 1 sub-steps) ─
 *
 *   - The sibling-race in `WorkflowEngineService.resume()` (the
 *     `status='waiting'` read-then-write window acknowledged in spec
 *     §3.5) was pulled forward into Phase 1.A — Phase 1.A makes the
 *     race REACHABLE (per-row claim of sibling link rows can fire
 *     concurrent resume() calls), so the engine fix shipped here too.
 *     resume() now uses an atomic UPDATE ... WHERE status='waiting'
 *     RETURNING ... as its first DB write; the losers no-op.
 *   - DOES NOT do multi-spawn aggregation. Per spec §9.3 LOCKED v2.2,
 *     v1 ships single-spawn only. Rows with `aggregation_group_id IS NOT
 *     NULL` are explicitly skipped at the candidate SELECT (filter
 *     above). Resuming them today would fire the parent once per
 *     sibling instead of once after aggregation strategy is met.
 *   - DOES NOT cascade parent-cancellation to children. That's the
 *     other half of §3.6 (cancelInstanceForBooking refactor) and lives
 *     in Phase 1.B's engine work.
 *   - DOES NOT run a cron loop. Tier 1 cron is Phase 1.C scope. The
 *     `wait_timeout_at` filter above (skip expired rows) is what
 *     reserves the timeout branch for the Tier 1 sweeper — without it,
 *     a late-arriving entity event would claim an already-expired row
 *     as `condition_met` and bury the `timeout` branch.
 *
 * ── Wait-condition gating (CRITICAL 1, CRITICAL 2) ──────────────────────
 *
 * The previous design claimed every matching (tenant_id, child_entity_id,
 * spawn_mode='wait') row in one UPDATE. That was wrong because:
 *   - A parent waiting on `wait_for='workflow_terminal'` is waiting for
 *     the CHILD WORKFLOW to terminate (a workflow-status event in
 *     Phase 1.B/C), NOT for the entity to be created/cancelled. Today's
 *     handler skips those candidates entirely.
 *   - A parent with `entity_terminal_statuses=['confirmed']` waiting on
 *     a status-change event whose new status is `released` (not in the
 *     allow-list) should NOT resume on `condition_met`. Today's handler
 *     filters out the candidate in JS (see `isWaitMatch`).
 *   - A parent whose `wait_timeout_at <= now()` is already expired and
 *     OWNED by the Tier 1 sweeper (Phase 1.C). Today's handler skips it
 *     so the cron can fire the `timeout` branch instead.
 *
 * ── Per-row claim + rollback (CRITICAL 3) ───────────────────────────────
 *
 * The previous design did a single bulk UPDATE … RETURNING that claimed
 * all matching rows at once. If row 2 of N failed its resume() call, the
 * outbox would retry the event — but the bulk UPDATE on retry matched
 * zero rows (all had `resolved_at IS NOT NULL`), so row 2's parent never
 * resumed — permanently stranded.
 *
 * New design: per-row UPDATE … WHERE id = X AND resolved_at IS NULL. On
 * resume failure we issue a follow-up UPDATE rolling `resolved_at` back
 * to NULL so the next retry can re-claim. The unclaim itself can fail
 * (transient driver wobble); if it does we LOG ERROR with the link id
 * so ops can manually intervene. This is the same trade-off as
 * "compensation can fail" — best-effort with audit.
 *
 * ── Cross-tenant defense ────────────────────────────────────────────────
 *
 * Service-role bypasses RLS. Defense-in-depth at every step:
 *   1. payload.tenant_id == event.tenant_id (handler entry, all 3 events).
 *   2. workflow_instance_links query is filtered by event.tenant_id.
 *   3. Per-row recheck: workflow_instances.tenant_id matches event.tenant_id
 *      before resume() is called. The link table's INSERT trigger
 *      (00370:205-228) already enforces this at write time, so a mismatch
 *      should never fire — but we defend anyway because the trigger only
 *      runs on INSERT, not on hypothetical row mutation.
 *
 * ── Module wiring ───────────────────────────────────────────────────────
 *
 * Three classes ship in this file, ONE per registered event literal —
 * `WorkflowSpawnWakeOnBookingCreated/Cancelled/StatusChanged`. The
 * @OutboxHandler decorator + DiscoveryService registry can only carry
 * one (eventType, version) per class (see outbox-handler.registry.ts:42-78
 * — duplicate registration throws). Each per-event class is a thin
 * delegator to the shared `runWake()` core; the decoration is the only
 * difference between them. They all share the same SupabaseService +
 * WorkflowEngineService injection (no duplicated state).
 *
 * ── Followups ───────────────────────────────────────────────────────────
 *
 *   - TODO(plan-reviewer I2): Phase 2/4 spec validator must reject
 *     spawn-node workflow definitions whose outbound edges don't carry
 *     the canonical branch labels (`cancelled`, `created`, status
 *     values, `unmatched_status_change`, `timeout`). NOT a Phase 1.A
 *     blocker — without the validator a misconfigured workflow can call
 *     resume() with a branch the engine doesn't recognise; engine
 *     fallback should treat it as no-op. Tracked in spec §4 (validator
 *     scope) for Phase 2 work.
 */

/**
 * Payload shape — common across all 3 lifecycle events. Producer
 * migrations 00372 + 00373 (and Phase 2's transition_booking_status RPC)
 * agree on `tenant_id` + `booking_id` + `started_at`. The remaining
 * fields are event-specific and inert to the wake handler today.
 */
export interface BookingLifecyclePayload {
  /** Tenant — duplicated from event.tenant_id for defense-in-depth. */
  tenant_id: string;
  /** The booking aggregate id. Used as `child_entity_id` in the link query. */
  booking_id: string;
  /** ISO timestamp captured by the producer (deterministic — bookings.created_at). */
  started_at: string;
  /** Cancellation reason (Cancelled event only). Inert here today. */
  reason?: string;
  /** Phase 2 status change context. Inert here until Phase 2 producer ships. */
  from_status?: string;
  to_status?: string;
  /** Created-event extras. Inert here today; future notification handlers will use them. */
  location_id?: string | null;
  requester_person_id?: string | null;
  host_person_id?: string | null;
  status?: string;
}

interface CandidateLink {
  id: string;
  parent_instance_id: string;
  parent_node_id: string;
  on_timeout_branch: string | null;
  wait_for: 'workflow_terminal' | 'entity_status' | 'either' | null;
  entity_terminal_statuses: string[] | null;
  wait_timeout_at: string | null;
}

/**
 * Shared core — does the actual wake work. Not decorated; the three
 * decorated classes below inject this and forward to it. Kept as a
 * separate Injectable so all three handler shells share state +
 * dependencies cleanly.
 */
@Injectable()
export class WorkflowSpawnWakeCore {
  private readonly log = new Logger(WorkflowSpawnWakeCore.name);

  constructor(
    private readonly supabase: SupabaseService,
    @Inject(forwardRef(() => WorkflowEngineService))
    private readonly workflowEngine: WorkflowEngineService,
  ) {}

  async runWake(
    event: OutboxEvent<BookingLifecyclePayload>,
    sourceEventType: BookingLifecycleEventTypeT,
  ): Promise<void> {
    const payload = event.payload;

    // ── 1. Tenant smuggling defense ───────────────────────────────────────
    if (!payload || payload.tenant_id !== event.tenant_id) {
      throw new DeadLetterError(
        `workflow_spawn_wake.tenant_mismatch: event.tenant_id=${event.tenant_id} payload.tenant_id=${payload?.tenant_id} event_type=${sourceEventType}`,
      );
    }

    // ── 2. Validate booking_id ────────────────────────────────────────────
    const bookingId = payload.booking_id;
    if (typeof bookingId !== 'string' || !UUID_RE.test(bookingId)) {
      throw new DeadLetterError(
        `workflow_spawn_wake.booking_id_invalid: '${bookingId}' is not a uuid (event_type=${sourceEventType})`,
      );
    }

    // ── 3. SELECT candidates with the full wake-eligibility filter ────────
    //
    // The composite partial index `idx_wil_wake_lookup`
    // (tenant_id, child_entity_id) WHERE resolved_at IS NULL AND
    // spawn_mode = 'wait' (00370:184-186) covers the WHERE shape; the
    // additional `wait_for IN (...)` + `aggregation_group_id IS NULL` +
    // `wait_timeout_at` filters are post-index residuals (cheap; few
    // candidates expected — typically 0 or 1 per booking lifecycle).
    //
    // Why we SELECT-then-per-row-UPDATE instead of bulk-UPDATE-RETURNING:
    // resume() failure must be able to roll the claim back. A bulk
    // UPDATE makes "row N succeeded, row N+1 failed" hard to recover
    // without a per-row follow-up. See header §"Per-row claim + rollback".
    const nowIso = new Date().toISOString();
    const candidatesRes = await this.supabase.admin
      .from('workflow_instance_links')
      .select(
        'id, parent_instance_id, parent_node_id, on_timeout_branch, wait_for, entity_terminal_statuses, wait_timeout_at',
      )
      .eq('tenant_id', event.tenant_id)
      .eq('child_entity_id', bookingId)
      .eq('spawn_mode', 'wait')
      .is('resolved_at', null)
      .is('aggregation_group_id', null)
      .in('wait_for', ['entity_status', 'either']);

    if (candidatesRes.error) {
      // PostgREST/Supabase wobble — transient.
      throw new Error(
        `workflow_spawn_wake.candidates_failed: ${candidatesRes.error.message} (event=${event.id} booking=${bookingId})`,
      );
    }

    const allCandidates = (candidatesRes.data ?? []) as CandidateLink[];

    // Filter out expired rows + status-mismatch rows. Doing this in JS
    // because supabase-js doesn't have an ergonomic `<value> = ANY(col)`
    // builder for text[] columns, and the `.contains` builder only works
    // with subset semantics that don't match the membership check we want.
    const eligible = allCandidates.filter((link) => {
      if (link.wait_timeout_at !== null && link.wait_timeout_at <= nowIso) {
        // Expired — Tier 1 cron's job (Phase 1.C). Leave for the timeout branch.
        return false;
      }
      return this.isWaitMatch(sourceEventType, payload, link);
    });

    if (eligible.length === 0) {
      this.log.log(
        `no_eligible_links event=${event.id} event_type=${sourceEventType} booking=${bookingId} candidates=${allCandidates.length}`,
      );
      return;
    }

    this.log.log(
      `${eligible.length} eligible link(s) event=${event.id} event_type=${sourceEventType} booking=${bookingId} (filtered_from=${allCandidates.length})`,
    );

    // ── 4. Per-row claim + resume ────────────────────────────────────────
    let lastError: Error | null = null;
    let failureCount = 0;
    let claimedCount = 0;

    for (const link of eligible) {
      // ── 4a. Atomic per-row claim ───────────────────────────────────────
      //
      // Timeout-ownership defense (codex IMPORTANT 2 remediation, 2026-05-12 Phase 1.C):
      // the SELECT above filters expired rows in JS, but `nowIso` is a
      // snapshot from before the SELECT. If `wait_timeout_at` passes
      // between SELECT and this UPDATE, the Phase 1.C cron sweeper owns
      // the row for the `timeout` branch — we must NOT claim it. Add the
      // condition to the WHERE so the UPDATE matches zero rows in that
      // race window.
      //
      // Original v1 used `.or('wait_timeout_at.is.null,wait_timeout_at.gt.now()')`.
      // PostgREST treats the value half of `gt.<value>` as a literal —
      // the special token for "current timestamp" is the bare string
      // `now` (no parens), not `now()`. With `now()`, PostgREST sends
      // the literal text `now()` to Postgres which fails to parse it
      // as a timestamp. The mock blessed the broken syntax which hid
      // the failure in unit tests but it would error against the real
      // DB. The cron sweeper at workflow-wait-sweeper.cron.ts:284 uses
      // `.lte('wait_timeout_at', new Date().toISOString())` — the
      // canonical pattern. We mirror it here, embedding the TS-side
      // ISO string into the `.or()` expression. The `.or()` parser
      // treats `,` as the disjunct separator and `.` as the part
      // separator inside each clause; ISO timestamps' `:` and `.` after
      // `gt.` are part of the value, not parsed as further parts.
      const claimNowIso = new Date().toISOString();
      const claimRes = await this.supabase.admin
        .from('workflow_instance_links')
        .update({
          resolved_at: claimNowIso,
          resolution_kind: 'condition_met',
        })
        .eq('id', link.id)
        .is('resolved_at', null)
        .or(`wait_timeout_at.is.null,wait_timeout_at.gt.${claimNowIso}`)
        .select('id');

      if (claimRes.error) {
        // Transient driver wobble on the claim itself.
        failureCount++;
        this.log.error(
          `claim_failed event=${event.id} link=${link.id}: ${claimRes.error.message}`,
        );
        lastError = new Error(claimRes.error.message);
        continue;
      }
      if (!claimRes.data || claimRes.data.length === 0) {
        // Another worker claimed it between our SELECT and UPDATE.
        // Concurrent-handler safe; skip.
        this.log.log(
          `link_already_claimed event=${event.id} link=${link.id} (concurrent worker)`,
        );
        continue;
      }
      claimedCount++;

      // ── 4b. Parent tenant assertion + resume ───────────────────────────
      try {
        const parentRes = await this.supabase.admin
          .from('workflow_instances')
          .select('id, tenant_id')
          .eq('id', link.parent_instance_id)
          .maybeSingle();

        if (parentRes.error) {
          throw new Error(
            `workflow_spawn_wake.parent_read_failed: ${parentRes.error.message} parent_instance=${link.parent_instance_id}`,
          );
        }
        if (!parentRes.data) {
          // Parent workflow_instance was deleted between claim + read.
          // The link's parent_instance_id FK has ON DELETE CASCADE
          // (00370:87-88), so a missing parent normally means the link
          // itself is gone — the claim above would have returned 0 rows.
          // Reaching here with a missing parent is a rare race: parent
          // was deleted AFTER the claim's snapshot but BEFORE the
          // parent SELECT. The claim is already permanent (resolved_at
          // set) — that's OK because the link FK cascade would have
          // removed it anyway. Skip; log.
          this.log.warn(
            `parent_instance_missing event=${event.id} parent=${link.parent_instance_id} link=${link.id}`,
          );
          continue;
        }

        const parentRow = parentRes.data as { id: string; tenant_id: string };
        if (parentRow.tenant_id !== event.tenant_id) {
          // The link table's INSERT trigger (00370:205-228) already
          // enforces this; reaching here means a row was mutated
          // post-INSERT or trigger was bypassed. Either way: terminal,
          // dead-letter — do NOT call resume across tenants.
          //
          // We do NOT unclaim the row here. The link is in a corrupt
          // state and ops needs to inspect it; leaving it claimed
          // prevents further wake attempts. The event dead-letters so
          // ops sees the alert.
          throw new DeadLetterError(
            `workflow_spawn_wake.parent_tenant_mismatch: parent_instance=${link.parent_instance_id} parent.tenant_id=${parentRow.tenant_id} event.tenant_id=${event.tenant_id} link=${link.id}`,
          );
        }

        // Branch label is ALWAYS `condition_met` for entity-event-driven
        // wakes (spec §3.4 / §3.6 / §3.11). The spawn-wait node's three
        // canonical branches are `condition_met` / `timeout` /
        // `parent_cancelled` — `timeout` is owned by the Phase 1.C cron,
        // `parent_cancelled` is owned by Phase 1.B's cancellation cascade.
        // The "what specifically satisfied the wait" detail is preserved
        // in:
        //   - `resolution_kind = 'condition_met'` on the link row (set above).
        //   - the `eligible link(s)` log line above + the `resumed` log line below.
        //   - downstream `instance_resumed` audit event (engine.resume emits).
        // engine.advance() falls through to `edges[0]` on an unmatched
        // edgeCondition (workflow-engine.service.ts:214); passing the raw
        // event verb here (e.g. `cancelled`) would silently take the
        // wrong branch in a workflow authored per the spec.
        const branch = 'condition_met';

        await this.workflowEngine.resume(
          link.parent_instance_id,
          event.tenant_id,
          branch,
        );

        this.log.log(
          `resumed event=${event.id} link=${link.id} parent=${link.parent_instance_id} parent_node=${link.parent_node_id} branch=${branch} source_event=${sourceEventType} booking=${bookingId}`,
        );
      } catch (err) {
        if (err instanceof DeadLetterError) {
          // Don't unclaim; surface immediately for ops triage.
          throw err;
        }
        // Transient — unclaim so a retry can re-attempt this row.
        failureCount++;
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(
          `resume_failed event=${event.id} link=${link.id} parent=${link.parent_instance_id} booking=${bookingId}: ${message}`,
        );
        lastError = err instanceof Error ? err : new Error(message);

        const unclaimRes = await this.supabase.admin
          .from('workflow_instance_links')
          .update({
            resolved_at: null,
            resolution_kind: null,
          })
          .eq('id', link.id);

        if (unclaimRes.error) {
          // Unclaim failed — link stays claimed but resume() never
          // happened. The Tier 1 cron sweeper (Phase 1.C) only inspects
          // resolved_at IS NULL rows, so a stranded claimed-but-unresumed
          // link would otherwise sit forever requiring SQL surgery.
          //
          // Codex IMPORTANT 3 remediation (2026-05-12): throw a PLAIN
          // Error here, NOT DeadLetterError. The outbox worker
          // (outbox.worker.ts:220) bypasses retry for DeadLetterError,
          // turning a transient DB blip into permanent strandedness. A
          // plain Error lets the backoff retries take another swing at
          // the unclaim; if the DB is genuinely down the retries
          // eventually exhaust and the event dead-letters at the worker
          // level (per outbox §4.4 / §4.5).
          throw new Error(
            `workflow_spawn_wake.unclaim_failed: link=${link.id} parent=${link.parent_instance_id} resume_error="${message}" unclaim_error="${unclaimRes.error.message}" — link in claimed state; retrying`,
          );
        }
      }
    }

    if (lastError) {
      throw new Error(
        `workflow_spawn_wake.partial_failure: ${failureCount} of ${eligible.length} resume(s) failed (claimed=${claimedCount}); last_error=${lastError.message} event=${event.id}`,
      );
    }
  }

  /**
   * Decide whether this event satisfies the wait condition on a link.
   * Returns true iff the event is the kind the parent was waiting for AND
   * the entity status (where relevant) is in `entity_terminal_statuses`.
   *
   * Per spec §3.5 the wait config has three modes:
   *   - `workflow_terminal` — wait for the child workflow_instance to
   *     reach a terminal status. NOT this handler's surface; the candidate
   *     SELECT above filters these out via `wait_for IN ('entity_status',
   *     'either')`. This function will never see one.
   *   - `entity_status` — wait for the child entity to reach one of
   *     `entity_terminal_statuses`. Cancelled → 'cancelled' must be in
   *     the list; Created → 'created' must be in the list; StatusChanged
   *     → `to_status` must be in the list.
   *   - `either` — same entity-status rules as above. The handler
   *     resumes on entity events; the OTHER half (resume on workflow
   *     status) is the engine's terminal hook in Phase 1.B/C.
   *
   * Edge case: `entity_terminal_statuses` is NULL or empty. The link
   * was misconfigured (the spec validator should reject this in
   * Phase 2 — see TODO in the header). We treat NULL/empty as "match
   * any" today to keep the wake working; in Phase 2 a validation gate
   * will reject the link at editor save time.
   */
  private isWaitMatch(
    sourceEventType: BookingLifecycleEventTypeT,
    payload: BookingLifecyclePayload,
    link: CandidateLink,
  ): boolean {
    // entity_terminal_statuses is the membership allow-list. Empty/null
    // = "no restriction" (see edge case above).
    const allowList = link.entity_terminal_statuses ?? [];
    const matchAny = allowList.length === 0;

    if (sourceEventType === BookingLifecycleEventType.Cancelled) {
      return matchAny || allowList.includes('cancelled');
    }
    if (sourceEventType === BookingLifecycleEventType.Created) {
      return matchAny || allowList.includes('created');
    }
    // StatusChanged
    const newStatus = payload.to_status ?? payload.status ?? null;
    if (newStatus === null) {
      // Producer contract violation — StatusChanged with no status.
      // Treat as no-match; the outbox event will log a `no_eligible_links`
      // line, which is the right outcome (don't fire a wake on no
      // information).
      return false;
    }
    return matchAny || allowList.includes(newStatus);
  }

  // resolveBranch() was removed (codex BLOCKER remediation, 2026-05-12).
  // The spawn-wait node's canonical outgoing-edge labels per spec §3.4 /
  // §3.6 / §3.11 are `condition_met` / `timeout` / `parent_cancelled`
  // ONLY. Tier 2 entity-event wakes always resolve to `condition_met`;
  // the verb-specific information (`cancelled` / `created` / status
  // value) lives in `resolution_kind` + structured log lines, NOT in the
  // engine branch label. Passing the raw verb here would silently take
  // `edges[0]` (engine.advance() fallback at workflow-engine.service.ts:214)
  // for any workflow authored against the spec.
}

@Injectable()
@OutboxHandler(BookingLifecycleEventType.Created, { version: 1 })
export class WorkflowSpawnWakeOnBookingCreatedHandler
  implements OutboxEventHandler<BookingLifecyclePayload>
{
  constructor(private readonly core: WorkflowSpawnWakeCore) {}

  async handle(event: OutboxEvent<BookingLifecyclePayload>): Promise<void> {
    return this.core.runWake(event, BookingLifecycleEventType.Created);
  }
}

@Injectable()
@OutboxHandler(BookingLifecycleEventType.Cancelled, { version: 1 })
export class WorkflowSpawnWakeOnBookingCancelledHandler
  implements OutboxEventHandler<BookingLifecyclePayload>
{
  constructor(
    private readonly core: WorkflowSpawnWakeCore,
    @Inject(forwardRef(() => WorkflowEngineService))
    private readonly workflowEngine: WorkflowEngineService,
  ) {}

  async handle(event: OutboxEvent<BookingLifecyclePayload>): Promise<void> {
    // Phase 1.5 sub-step 6.A, Change 6: cancel the DRIVING workflow
    // instance for this booking (if any) BEFORE the wake processing. The
    // wake half (`core.runWake`) handles parent workflows that were
    // WAITING for this booking event — but a workflow whose entity_kind=
    // 'booking' and whose booking_id IS this booking is DRIVING the
    // booking's lifecycle, and its approvals must expire when the booking
    // dies.
    //
    // CRITICAL fix (2026-05-14 adversarial review #1): the v1 of this
    // handler called `cancelInstance('booking', bookingId, …)`, which
    // does an entity-FK lookup `WHERE entity_kind='booking' AND
    // booking_id=$id`. But `workflow_instances.booking_id` is
    // `ON DELETE SET NULL` (00369:231-233), and `delete_booking_with_guard`
    // (00373) DELETES the booking row + enqueues `booking.cancelled` in
    // the same transaction. By the time this handler runs, the
    // booking_id column is NULL on every workflow_instance — the FK
    // lookup returned zero rows and the driving instance was permanently
    // stranded with pending approvals.
    //
    // Fix: route through `cancelInstanceForBooking` which discovers the
    // driving instance via the SURVIVING `approvals.workflow_instance_id`
    // column (the polymorphic approvals.target_entity_id text/uuid pair
    // is NOT a FK to bookings, so the approvals survive the booking
    // delete with their workflow_instance_id intact).
    //
    // Order matters: cancel the driving instance FIRST so its
    // `instance_cancelled` audit event sequences before any wait-link
    // resume events — the audit timeline reads "booking cancelled →
    // driving workflow cancelled → waiting parent workflows wake on the
    // cancelled branch".
    //
    // Errors here are propagated (not swallowed) — this handler is
    // outbox-driven so a transient failure means the event re-runs after
    // outbox retry; cancelInstanceForBooking is idempotent (per-instance
    // atomic claim).
    const payload = event.payload;
    if (payload && payload.tenant_id === event.tenant_id) {
      const bookingId = payload.booking_id;
      if (typeof bookingId === 'string') {
        await this.workflowEngine.cancelInstanceForBooking(
          bookingId,
          event.tenant_id,
          'booking_cancelled',
        );
      }
    }
    return this.core.runWake(event, BookingLifecycleEventType.Cancelled);
  }
}

@Injectable()
@OutboxHandler(BookingLifecycleEventType.StatusChanged, { version: 1 })
export class WorkflowSpawnWakeOnBookingStatusChangedHandler
  implements OutboxEventHandler<BookingLifecyclePayload>
{
  constructor(private readonly core: WorkflowSpawnWakeCore) {}

  async handle(event: OutboxEvent<BookingLifecyclePayload>): Promise<void> {
    return this.core.runWake(event, BookingLifecycleEventType.StatusChanged);
  }
}
