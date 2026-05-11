/**
 * B.2.A.8 concurrency probe — update_entity_combined (§3.0 orchestrator).
 *
 * Spec ref: docs/follow-ups/b2-survey-and-design.md §3.0 (lines 1781-1897).
 * Migration: supabase/migrations/00332_update_entity_combined_v2.sql
 *   (supersedes 00331; F1-F4 fixes folded in).
 * Harness style follows update_entity_sla.spec.ts (00330).
 *
 * Eleven scenarios, all against the live local Supabase stack:
 *   1. Multi-branch happy path — patches with status + priority +
 *      assignment + metadata; all branches commit in one tx; assert
 *      returned branches_applied + row state on tickets +
 *      ticket_activities row counts (one per mutated branch) +
 *      domain_events for status+assignment only.
 *   2. Idempotent replay — same outer key + same payload returns
 *      cached_result; no extra rows in command_operations /
 *      ticket_activities / domain_events.
 *   3. Payload mismatch — same outer key, different patches raises
 *      'command_operations.payload_mismatch'.
 *   4. Full no-op — patches that match current row state across all
 *      branches → returns noop=true, no rows written anywhere.
 *   5. Plan-on-case rejected — kind='case' with patches.plan →
 *      'update_entity_combined.plan_not_supported_on_case'.
 *   6. Cross-tenant watcher rejected — TWO sub-probes:
 *        6a. watcher is a person in tenant B (cross-tenant) → invalid_watcher.
 *        6b. watcher is a ghost uuid (gen_random_uuid()) → invalid_watcher.
 *      Both raise the SAME registered code. Verify NO partial writes.
 *   7. Nested idempotency replay — outer key reused with same payload;
 *      verifies that the SECOND outer call hits the OUTER cache and
 *      short-circuits before re-entering any inner RPC (only ONE row
 *      per inner command_operations key, despite two outer calls).
 *   8. Partial-vs-full distinction — patches={status:...} fires only
 *      status branch; patches={} fires no branches (returns noop:true).
 *   9. WO plan branch happy path — kind='work_order' with plan: {…}
 *      updates work_orders columns, emits one plan_changed activity,
 *      no domain_events.
 *  10. Duplicate watcher uuid in metadata input — F2 dedup. Send
 *      `metadata.watchers = [uuidA, uuidA]` where uuidA is a valid
 *      tenant person. RPC succeeds (no false invalid_watcher);
 *      persisted tickets.watchers = [uuidA]; one metadata_changed
 *      activity with the deduped diff.
 *  11. Invalid plan input — bad timestamp (F3). Send
 *      kind='work_order' with plan = {planned_start_at: 'not-a-date'}
 *      raises 'update_entity_combined.invalid_plan'. No partial writes.
 *  12. SLA branch happy path (v3 / codex F11). Send `kind='case'` with
 *      patches.sla = {sla_id: <tenant>, timers: [response, resolution]}.
 *      Assert tickets.sla_id is set, branches_applied contains 'sla',
 *      result.sla.noop=false, two active sla_timers with
 *      recompute_pending=false, one ticket_activities `sla_changed`,
 *      one domain_events `ticket_sla_changed`, no outbox row (SLA RPC
 *      does NOT emit outbox; 00330:1-393 has only domain_events +
 *      activities). Two command_operations rows (outer + sla inner
 *      with sentinel prefix).
 *  13. SLA branch idempotent replay (v3 / codex F11). Send the same
 *      payload + outer key twice. Second call hits the outer cache;
 *      no additional rows in sla_timers / ticket_activities /
 *      domain_events / command_operations.
 *  14. Status + SLA combined-call ordering (v3 / codex F11). Send
 *      `kind='case'` with patches.status_category='waiting' +
 *      waiting_reason='vendor' + patches.sla = {sla_id, timers} +
 *      a pre-existing SLA + timers. Document the spec-ordered
 *      interaction:
 *        a. Status branch fires first → sets recompute_pending=true on
 *           the existing active timers + emits
 *           outbox.events 'sla.timer_recompute_required' (00325:289-313).
 *        b. SLA branch fires second → stops the existing timers
 *           (stopped_reason='sla_changed') and inserts fresh timers
 *           with recompute_pending=false (00330).
 *      End state: two stopped timers + two active fresh timers; one
 *      wasted outbox 'sla.timer_recompute_required' (the worker
 *      queries `recompute_pending=true AND stopped_at IS NULL` and
 *      finds none, no-ops — see b2-followups.md C3). Both branches
 *      appear in branches_applied; both ticket_activities rows
 *      present (status_changed + sla_changed).
 *  15. SLA branch nested idempotency / inner-cache reuse (v3 / codex
 *      F11). Run the orchestrator once with patches.sla. Then call
 *      update_entity_sla DIRECTLY with the SAME inner key
 *      (`__combined__:sla:<kind>:<id>:<outer>`) and the SAME payload.
 *      The direct call must hit the inner command_operations cache
 *      and return without rewriting (no new sla_timers /
 *      ticket_activities / domain_events). Documents the inner-cache
 *      reuse semantics + verifies the F1 sentinel prevents accidental
 *      collision (any sibling caller minting `__combined__:`-prefixed
 *      keys is by convention reserved to the orchestrator).
 *
 * Sentinel for inner idempotency keys (F1): `__combined__:`. Direct
 * callers of transition_entity_status / set_entity_assignment /
 * update_entity_sla MUST NOT mint keys with this prefix.
 */

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  flushAllFixtures,
  registerCleanup,
  runRpcCapture,
  seedBaseFixture,
  withClient,
} from './helpers';
import { endPool, getPool } from './pool';

interface SeededTicket {
  ticketId: string;
}

interface SeededWorkOrder {
  ticketId: string;
  workOrderId: string;
}

interface SeededUser {
  userId: string;
  authUid: string;
  personId: string;
}

interface SeededSla {
  slaId: string;
  responseMinutes: number;
  resolutionMinutes: number;
}

interface SlaInnerResult {
  entity_id: string;
  entity_kind: string;
  previous_sla_id: string | null;
  new_sla_id: string | null;
  timers_inserted: number;
  noop: boolean;
}

interface CombinedResult {
  entity_id: string;
  entity_kind: string;
  branches_applied: string[];
  status: Record<string, unknown> | null;
  assignment: Record<string, unknown> | null;
  sla: Record<string, unknown> | null;
  priority: { previous: string | null; next: string | null; changed: boolean } | null;
  plan: {
    previous: { planned_start_at: string | null; planned_duration_minutes: number | null };
    next: { planned_start_at: string | null; planned_duration_minutes: number | null };
    changed: boolean;
  } | null;
  metadata: { changes: Record<string, unknown>; changed: boolean } | null;
  any_changed: boolean;
  noop: boolean;
}

/**
 * Seed a tickets row in 'new'. Cleanup wipes every table this RPC may
 * touch (command_operations, sla_timers, ticket_activities, domain_events,
 * routing_decisions, outbox.events, work_orders, tickets, sla_policies).
 *
 * Mirrors update_entity_sla.spec.ts seedCase + adds routing_decisions
 * (assignment branch) and outbox.events (status branch).
 */
async function seedCase(
  pool: Pool,
  base: { tenantId: string; personId: string },
  opts: {
    priority?: string;
    title?: string;
    description?: string | null;
    cost?: number | null;
    tags?: string[];
    watchers?: string[];
  } = {},
): Promise<SeededTicket> {
  const ticketId = randomUUID();
  const tags = opts.tags ?? [];
  const watchers = opts.watchers ?? [];
  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      await c.query(
        `insert into public.tickets
           (id, tenant_id, title, description, status, status_category,
            priority, requester_person_id, source_channel, cost, tags, watchers)
         values ($1, $2, $3, $4, 'new', 'new', $5, $6, 'system', $7, $8::text[], $9::uuid[])`,
        [
          ticketId,
          base.tenantId,
          opts.title ?? 'Concurrency combined case',
          opts.description ?? null,
          opts.priority ?? 'medium',
          base.personId,
          opts.cost ?? null,
          tags,
          watchers,
        ],
      );
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    }
  });

  registerCleanup(async () => {
    await withClient(pool, async (c) => {
      await c.query('begin');
      try {
        await c.query("set local session_replication_role = 'replica'");
        await c.query('delete from public.command_operations where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.sla_timers where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.routing_decisions where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.ticket_activities where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.domain_events where tenant_id = $1', [base.tenantId]);
        await c.query('delete from outbox.events where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.sla_policies where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.work_orders where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.tickets where tenant_id = $1', [base.tenantId]);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    });
  });

  return { ticketId };
}

/**
 * Seed a parent case + a child work_order in 'new' status. Used for
 * WO-side scenarios (plan branch, etc.). Cleanup is shared with the
 * parent's tenant via the seedCase pattern.
 */
async function seedWorkOrder(
  pool: Pool,
  base: { tenantId: string; personId: string },
  opts: {
    priority?: string;
    plannedStartAt?: string | null;
    plannedDurationMinutes?: number | null;
  } = {},
): Promise<SeededWorkOrder> {
  const ticketId = randomUUID();
  const workOrderId = randomUUID();
  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      await c.query(
        `insert into public.tickets
           (id, tenant_id, title, status, status_category,
            requester_person_id, source_channel)
         values ($1, $2, 'Concurrency parent case', 'new', 'new', $3, 'system')`,
        [ticketId, base.tenantId, base.personId],
      );
      await c.query(
        `insert into public.work_orders
           (id, tenant_id, parent_kind, parent_ticket_id,
            title, status, status_category, priority, source_channel,
            planned_start_at, planned_duration_minutes)
         values ($1, $2, 'case', $3, 'Concurrency child WO', 'new', 'new', $4,
                 'system', $5, $6)`,
        [
          workOrderId,
          base.tenantId,
          ticketId,
          opts.priority ?? 'medium',
          opts.plannedStartAt ?? null,
          opts.plannedDurationMinutes ?? null,
        ],
      );
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    }
  });

  registerCleanup(async () => {
    await withClient(pool, async (c) => {
      await c.query('begin');
      try {
        await c.query("set local session_replication_role = 'replica'");
        await c.query('delete from public.command_operations where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.sla_timers where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.routing_decisions where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.ticket_activities where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.domain_events where tenant_id = $1', [base.tenantId]);
        await c.query('delete from outbox.events where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.sla_policies where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.work_orders where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.tickets where tenant_id = $1', [base.tenantId]);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    });
  });

  return { ticketId, workOrderId };
}

/**
 * Seed a user (with backing person) scoped to a tenant. The assignment
 * branch's validate_assignees_in_tenant gate needs a real user row in
 * the right tenant.
 */
async function seedUser(pool: Pool, tenantId: string): Promise<SeededUser> {
  const userId = randomUUID();
  const authUid = randomUUID();
  const personId = randomUUID();

  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      await c.query("set local session_replication_role = 'replica'");
      await c.query(
        `insert into public.persons (id, tenant_id, type, first_name, last_name, email)
         values ($1, $2, 'employee', 'Assignee', 'Combined', $3)`,
        [personId, tenantId, `assignee-${personId.slice(0, 8)}@concurrency.test`],
      );
      await c.query(
        `insert into public.users (id, tenant_id, auth_uid, email, person_id, status)
         values ($1, $2, $3, $4, $5, 'active')`,
        [userId, tenantId, authUid, `user-${userId.slice(0, 8)}@concurrency.test`, personId],
      );
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    }
  });

  registerCleanup(async () => {
    await withClient(pool, async (c) => {
      await c.query('begin');
      try {
        await c.query("set local session_replication_role = 'replica'");
        await c.query('delete from public.users where id = $1', [userId]);
        await c.query('delete from public.persons where id = $1', [personId]);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    });
  });

  return { userId, authUid, personId };
}

/**
 * Insert a minimal sla_policies row for the tenant. Cleanup is handled
 * by seedCase / seedWorkOrder which both delete sla_policies for the
 * tenant on teardown. Mirrors update_entity_sla.spec.ts:187-201.
 */
async function seedSlaPolicy(
  pool: Pool,
  tenantId: string,
  opts: { responseMinutes?: number; resolutionMinutes?: number; name?: string } = {},
): Promise<SeededSla> {
  const slaId = randomUUID();
  const responseMinutes = opts.responseMinutes ?? 60;
  const resolutionMinutes = opts.resolutionMinutes ?? 240;
  await pool.query(
    `insert into public.sla_policies
       (id, tenant_id, name, response_time_minutes, resolution_time_minutes, active)
     values ($1, $2, $3, $4, $5, true)`,
    [slaId, tenantId, opts.name ?? 'Concurrency combined SLA', responseMinutes, resolutionMinutes],
  );
  return { slaId, responseMinutes, resolutionMinutes };
}

/**
 * Build the {timers:[…]} array the SLA branch expects (mirrors
 * update_entity_sla.spec.ts:211-229 — the RPC does NOT do business-hours
 * math; due_at is TS-computed wall-clock now()+minutes).
 */
function buildTimersPayload(sla: SeededSla, base: { startAt?: Date } = {}) {
  const now = base.startAt ?? new Date();
  const responseDue = new Date(now.getTime() + sla.responseMinutes * 60_000);
  const resolutionDue = new Date(now.getTime() + sla.resolutionMinutes * 60_000);
  return [
    {
      timer_type: 'response',
      target_minutes: sla.responseMinutes,
      due_at: responseDue.toISOString(),
      business_hours_calendar_id: null,
    },
    {
      timer_type: 'resolution',
      target_minutes: sla.resolutionMinutes,
      due_at: resolutionDue.toISOString(),
      business_hours_calendar_id: null,
    },
  ];
}

describe('update_entity_combined — §3.0 orchestrator RPC', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = getPool();
  });

  afterAll(async () => {
    await flushAllFixtures(pool);
    await endPool();
  });

  // ─────────────────────────────────────────────────────────────────────
  it('scenario 1: multi-branch happy path — status + priority + assignment + metadata commit atomically; correct activity/event counts', async () => {
    const base = await seedBaseFixture(pool, `comb-multi-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base, { priority: 'medium', title: 'Orig title' });
    const assignee = await seedUser(pool, base.tenantId);

    const idem = `comb-multi-${ticketId}`;
    const patches = {
      status: 'in_progress',
      status_category: 'in_progress',
      priority: 'high',
      assignment: { assigned_user_id: assignee.userId },
      metadata: { title: 'New title', tags: ['a', 'b'] },
    };

    const result = await runRpcCapture<CombinedResult>(
      pool,
      'public.update_entity_combined',
      ['case', ticketId, base.tenantId, null, idem, patches],
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.entity_kind).toBe('case');
    expect(result.value.entity_id).toBe(ticketId);
    expect(result.value.branches_applied.sort()).toEqual(
      ['assignment', 'metadata', 'priority', 'status'].sort(),
    );
    expect(result.value.any_changed).toBe(true);
    expect(result.value.noop).toBe(false);

    // Sub-RPC results.
    expect(result.value.status).not.toBeNull();
    expect(result.value.status?.noop).toBe(false);
    expect(result.value.assignment).not.toBeNull();
    expect(result.value.assignment?.noop).toBe(false);
    expect(result.value.priority?.changed).toBe(true);
    expect(result.value.priority?.previous).toBe('medium');
    expect(result.value.priority?.next).toBe('high');
    expect(result.value.metadata?.changed).toBe(true);

    // tickets row reflects the writes.
    const t = await pool.query(
      `select status, status_category, priority, assigned_user_id, title, tags
         from public.tickets where id = $1`,
      [ticketId],
    );
    expect(t.rows[0].status).toBe('in_progress');
    expect(t.rows[0].status_category).toBe('in_progress');
    expect(t.rows[0].priority).toBe('high');
    expect(t.rows[0].assigned_user_id).toBe(assignee.userId);
    expect(t.rows[0].title).toBe('New title');
    expect(t.rows[0].tags).toEqual(['a', 'b']);

    // ticket_activities — exactly one row per mutated branch (status,
    // priority, assignment, metadata = 4). Inline branches and sub-RPC
    // branches each emit ONE row per call.
    const acts = await pool.query(
      `select metadata->>'event' as event
         from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2
        order by created_at`,
      [base.tenantId, ticketId],
    );
    expect(acts.rowCount).toBe(4);
    const events = acts.rows.map((r) => r.event).sort();
    expect(events).toEqual(['assignment_changed', 'metadata_changed', 'priority_changed', 'status_changed']);

    // domain_events — assignment emits (00327 C1+C2: domain_events).
    // status emits via outbox.events instead (00325 lines 349-369); priority
    // + metadata are inline and emit NEITHER. So we expect exactly one
    // domain_events row for ticket_assigned. The status emission lives in
    // outbox.events as 'ticket_status_changed'.
    const evs = await pool.query(
      `select event_type from public.domain_events
        where tenant_id = $1 and entity_id = $2
        order by event_type`,
      [base.tenantId, ticketId],
    );
    expect(evs.rowCount).toBe(1);
    expect(evs.rows.map((r) => r.event_type)).toEqual(['ticket_assigned']);

    // Status emits to outbox.events. Verify exactly one such row exists.
    const outbox = await pool.query(
      `select event_type from outbox.events
        where tenant_id = $1 and aggregate_id = $2
          and event_type = 'ticket_status_changed'`,
      [base.tenantId, ticketId],
    );
    expect(outbox.rowCount).toBe(1);

    // command_operations rows: 1 outer + 1 per sub-RPC branch (status,
    // assignment). The sla branch wasn't invoked.
    const co = await pool.query(
      `select idempotency_key from public.command_operations
        where tenant_id = $1
        order by idempotency_key`,
      [base.tenantId],
    );
    expect(co.rowCount).toBe(3);
    const keys = co.rows.map((r) => r.idempotency_key);
    expect(keys).toContain(idem);
    // F1: inner keys carry the `__combined__:` sentinel prefix so direct
    // callers of sibling RPCs cannot collide with orchestrator-derived
    // inner keys. Suffix is `:<branch>:<kind>:<id>:<outer>`.
    expect(keys).toContain(`__combined__:status:case:${ticketId}:${idem}`);
    expect(keys).toContain(`__combined__:assignment:case:${ticketId}:${idem}`);
  });

  // ─────────────────────────────────────────────────────────────────────
  it('scenario 2: idempotent replay — same outer key + same payload returns cached_result; no extra rows', async () => {
    const base = await seedBaseFixture(pool, `comb-replay-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base, { priority: 'medium' });

    const idem = `comb-replay-${ticketId}`;
    const patches = { priority: 'high' };

    const first = await runRpcCapture<CombinedResult>(
      pool,
      'public.update_entity_combined',
      ['case', ticketId, base.tenantId, null, idem, patches],
    );
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(first.value.priority?.changed).toBe(true);

    // Snapshot counts after the first call.
    const beforeActs = await pool.query(
      `select count(*)::int as n from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    const beforeCo = await pool.query(
      `select count(*)::int as n from public.command_operations where tenant_id = $1`,
      [base.tenantId],
    );

    // Replay with the same key + payload — must take the cache path.
    const second = await runRpcCapture<CombinedResult>(
      pool,
      'public.update_entity_combined',
      ['case', ticketId, base.tenantId, null, idem, patches],
    );
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.value).toEqual(first.value);

    // No new rows after the replay.
    const afterActs = await pool.query(
      `select count(*)::int as n from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    const afterCo = await pool.query(
      `select count(*)::int as n from public.command_operations where tenant_id = $1`,
      [base.tenantId],
    );
    expect(afterActs.rows[0].n).toBe(beforeActs.rows[0].n);
    expect(afterCo.rows[0].n).toBe(beforeCo.rows[0].n);
  });

  // ─────────────────────────────────────────────────────────────────────
  it('scenario 3: payload mismatch — same outer key + different patches raises command_operations.payload_mismatch', async () => {
    const base = await seedBaseFixture(pool, `comb-mismatch-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base, { priority: 'medium' });

    const idem = `comb-mismatch-${ticketId}`;
    const first = await runRpcCapture<CombinedResult>(
      pool,
      'public.update_entity_combined',
      ['case', ticketId, base.tenantId, null, idem, { priority: 'high' }],
    );
    expect(first.kind).toBe('ok');

    const second = await runRpcCapture<CombinedResult>(
      pool,
      'public.update_entity_combined',
      ['case', ticketId, base.tenantId, null, idem, { priority: 'critical' }],
    );
    expect(second.kind).toBe('error');
    if (second.kind !== 'error') return;
    expect(second.error.message).toMatch(/command_operations\.payload_mismatch/);
  });

  // ─────────────────────────────────────────────────────────────────────
  it('scenario 4: full no-op — patches matching current state across all branches → noop=true, no rows', async () => {
    const base = await seedBaseFixture(pool, `comb-noop-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base, {
      priority: 'medium',
      title: 'Orig',
      tags: ['x'],
    });

    const idem = `comb-noop-${ticketId}`;
    // All fields match current state — every branch should self-detect noop.
    const patches = {
      priority: 'medium',
      metadata: { title: 'Orig', tags: ['x'] },
    };

    const result = await runRpcCapture<CombinedResult>(
      pool,
      'public.update_entity_combined',
      ['case', ticketId, base.tenantId, null, idem, patches],
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.any_changed).toBe(false);
    expect(result.value.noop).toBe(true);
    expect(result.value.priority?.changed).toBe(false);
    expect(result.value.metadata?.changed).toBe(false);

    // No ticket_activities, no domain_events.
    const acts = await pool.query(
      `select count(*)::int as n from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(acts.rows[0].n).toBe(0);

    const evs = await pool.query(
      `select count(*)::int as n from public.domain_events
        where tenant_id = $1 and entity_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(evs.rows[0].n).toBe(0);

    // Outer command_operations row exists with noop=true cached_result.
    const co = await pool.query(
      `select outcome, cached_result->>'noop' as noop
         from public.command_operations
        where tenant_id = $1 and idempotency_key = $2`,
      [base.tenantId, idem],
    );
    expect(co.rowCount).toBe(1);
    expect(co.rows[0].outcome).toBe('success');
    expect(co.rows[0].noop).toBe('true');
  });

  // ─────────────────────────────────────────────────────────────────────
  it('scenario 5: plan-on-case rejected — kind=case + patches.plan raises plan_not_supported_on_case', async () => {
    const base = await seedBaseFixture(pool, `comb-plan-case-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);

    const idem = `comb-plan-case-${ticketId}`;
    const result = await runRpcCapture<CombinedResult>(
      pool,
      'public.update_entity_combined',
      [
        'case',
        ticketId,
        base.tenantId,
        null,
        idem,
        { plan: { planned_start_at: '2026-09-01T10:00:00Z', planned_duration_minutes: 60 } },
      ],
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toMatch(/update_entity_combined\.plan_not_supported_on_case/);

    // No writes; the guard runs before any branch fires.
    const acts = await pool.query(
      `select count(*)::int as n from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(acts.rows[0].n).toBe(0);

    const co = await pool.query(
      `select count(*)::int as n from public.command_operations where tenant_id = $1`,
      [base.tenantId],
    );
    expect(co.rows[0].n).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────
  it('scenario 6: cross-tenant + ghost-uuid watcher both rejected with invalid_watcher; outer tx rolls back; no partial writes', async () => {
    // Probe 6a: foreign-tenant person (genuine cross-tenant probe).
    // Probe 6b: a uuid-shaped value that doesn't exist anywhere
    //          (gen_random_uuid()). Same registered code expected.
    // Documents that the RPC normalizes both failure modes to the same
    // surface — consistent with the TS surface's behavior (see
    // apps/api/src/common/tenant-validation.ts:295-309).

    const tenantA = await seedBaseFixture(pool, `comb-xwatch-a-${Date.now()}`);
    const tenantB = await seedBaseFixture(pool, `comb-xwatch-b-${Date.now()}`);

    // ── 6a — cross-tenant ─────────────────────────────────────────────
    const { ticketId: ticketIdA } = await seedCase(pool, tenantA, { priority: 'medium', title: 'Orig' });
    const foreignPersonId = tenantB.personId;

    const idemA = `comb-xwatch-cross-${ticketIdA}`;
    // Include a successful-looking priority branch BEFORE the metadata
    // branch. If atomicity is broken the priority write would leak.
    const resultA = await runRpcCapture<CombinedResult>(
      pool,
      'public.update_entity_combined',
      [
        'case',
        ticketIdA,
        tenantA.tenantId,
        null,
        idemA,
        {
          priority: 'high',
          metadata: { title: 'Patched title', watchers: [foreignPersonId] },
        },
      ],
    );
    expect(resultA.kind).toBe('error');
    if (resultA.kind !== 'error') return;
    expect(resultA.error.message).toMatch(/update_entity_combined\.invalid_watcher/);

    // tickets row unchanged — priority + title roll back with metadata.
    const tA = await pool.query(
      'select priority, title from public.tickets where id = $1',
      [ticketIdA],
    );
    expect(tA.rows[0].priority).toBe('medium');
    expect(tA.rows[0].title).toBe('Orig');

    const actsA = await pool.query(
      `select count(*)::int as n from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [tenantA.tenantId, ticketIdA],
    );
    expect(actsA.rows[0].n).toBe(0);

    const coA = await pool.query(
      `select count(*)::int as n from public.command_operations
        where tenant_id = $1 and idempotency_key = $2`,
      [tenantA.tenantId, idemA],
    );
    expect(coA.rows[0].n).toBe(0);

    // ── 6b — ghost uuid (random, doesn't exist) ───────────────────────
    const { ticketId: ticketIdB } = await seedCase(pool, tenantA, { priority: 'medium', title: 'Orig' });
    const ghostUuid = randomUUID();

    const idemB = `comb-xwatch-ghost-${ticketIdB}`;
    const resultB = await runRpcCapture<CombinedResult>(
      pool,
      'public.update_entity_combined',
      [
        'case',
        ticketIdB,
        tenantA.tenantId,
        null,
        idemB,
        {
          priority: 'high',
          metadata: { title: 'Patched title', watchers: [ghostUuid] },
        },
      ],
    );
    expect(resultB.kind).toBe('error');
    if (resultB.kind !== 'error') return;
    // Same registered code as 6a — invalid_watcher.
    expect(resultB.error.message).toMatch(/update_entity_combined\.invalid_watcher/);

    const tB = await pool.query(
      'select priority, title from public.tickets where id = $1',
      [ticketIdB],
    );
    expect(tB.rows[0].priority).toBe('medium');
    expect(tB.rows[0].title).toBe('Orig');

    const actsB = await pool.query(
      `select count(*)::int as n from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [tenantA.tenantId, ticketIdB],
    );
    expect(actsB.rows[0].n).toBe(0);

    const coB = await pool.query(
      `select count(*)::int as n from public.command_operations
        where tenant_id = $1 and idempotency_key = $2`,
      [tenantA.tenantId, idemB],
    );
    expect(coB.rows[0].n).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────
  it('scenario 7: nested idempotency replay — outer cache hit short-circuits before re-entering sub-RPCs', async () => {
    const base = await seedBaseFixture(pool, `comb-nested-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const assignee = await seedUser(pool, base.tenantId);

    const idem = `comb-nested-${ticketId}`;
    const patches = {
      status: 'in_progress',
      status_category: 'in_progress',
      assignment: { assigned_user_id: assignee.userId },
    };

    const first = await runRpcCapture<CombinedResult>(
      pool,
      'public.update_entity_combined',
      ['case', ticketId, base.tenantId, null, idem, patches],
    );
    expect(first.kind).toBe('ok');

    // After the first call, exactly THREE command_operations rows:
    // outer + status sub + assignment sub.
    const beforeCo = await pool.query(
      `select idempotency_key from public.command_operations
        where tenant_id = $1
        order by idempotency_key`,
      [base.tenantId],
    );
    expect(beforeCo.rowCount).toBe(3);

    // Replay the outer call. Per the outer cache hit, the RPC must
    // return early — NEVER re-enter transition_entity_status or
    // set_entity_assignment. Their command_operations rows must
    // therefore remain exactly as they were after call #1 (no
    // duplicate inserts, no updates).
    const second = await runRpcCapture<CombinedResult>(
      pool,
      'public.update_entity_combined',
      ['case', ticketId, base.tenantId, null, idem, patches],
    );
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.value).toEqual(first.value);

    const afterCo = await pool.query(
      `select idempotency_key from public.command_operations
        where tenant_id = $1
        order by idempotency_key`,
      [base.tenantId],
    );
    expect(afterCo.rowCount).toBe(3);
    expect(afterCo.rows.map((r) => r.idempotency_key)).toEqual(
      beforeCo.rows.map((r) => r.idempotency_key),
    );

    // No new ticket_activities or domain_events either.
    const acts = await pool.query(
      `select metadata->>'event' as event
         from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2
        order by created_at`,
      [base.tenantId, ticketId],
    );
    // Exactly 2: status_changed + assignment_changed. No duplicates.
    expect(acts.rowCount).toBe(2);
    const events = acts.rows.map((r) => r.event).sort();
    expect(events).toEqual(['assignment_changed', 'status_changed']);
  });

  // ─────────────────────────────────────────────────────────────────────
  it('scenario 8: partial-vs-full distinction — {status:…} fires only status; {} fires no branches', async () => {
    const base = await seedBaseFixture(pool, `comb-partial-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);

    // Case A: only the status branch.
    const idemA = `comb-partial-${ticketId}-A`;
    const resultA = await runRpcCapture<CombinedResult>(
      pool,
      'public.update_entity_combined',
      [
        'case',
        ticketId,
        base.tenantId,
        null,
        idemA,
        { status: 'in_progress', status_category: 'in_progress' },
      ],
    );
    expect(resultA.kind).toBe('ok');
    if (resultA.kind !== 'ok') return;
    expect(resultA.value.branches_applied).toEqual(['status']);
    expect(resultA.value.priority).toBeNull();
    expect(resultA.value.assignment).toBeNull();
    expect(resultA.value.sla).toBeNull();
    expect(resultA.value.metadata).toBeNull();
    expect(resultA.value.plan).toBeNull();
    expect(resultA.value.any_changed).toBe(true);

    // Activities — exactly ONE (status_changed). No priority etc.
    const acts1 = await pool.query(
      `select metadata->>'event' as event from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(acts1.rowCount).toBe(1);
    expect(acts1.rows[0].event).toBe('status_changed');

    // Case B: empty patches → no branches, full noop.
    const idemB = `comb-partial-${ticketId}-B`;
    const resultB = await runRpcCapture<CombinedResult>(
      pool,
      'public.update_entity_combined',
      ['case', ticketId, base.tenantId, null, idemB, {}],
    );
    expect(resultB.kind).toBe('ok');
    if (resultB.kind !== 'ok') return;
    expect(resultB.value.branches_applied).toEqual([]);
    expect(resultB.value.any_changed).toBe(false);
    expect(resultB.value.noop).toBe(true);

    // Activities unchanged (still 1 from case A).
    const acts2 = await pool.query(
      `select count(*)::int as n from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(acts2.rows[0].n).toBe(1);

    // Both outer calls have their own outer command_operations rows.
    // Filter precisely to the OUTER keys (no `:status:...` suffix) so the
    // case-A status sub-RPC row doesn't leak into the count.
    const co = await pool.query(
      `select idempotency_key from public.command_operations
        where tenant_id = $1 and idempotency_key = any($2::text[])
        order by idempotency_key`,
      [base.tenantId, [idemA, idemB]],
    );
    expect(co.rowCount).toBe(2);

    // And case A also wrote its status sub-key row (nested idempotency).
    // F1: sentinel-prefixed key.
    const subCo = await pool.query(
      `select idempotency_key from public.command_operations
        where tenant_id = $1 and idempotency_key = $2`,
      [base.tenantId, `__combined__:status:case:${ticketId}:${idemA}`],
    );
    expect(subCo.rowCount).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────────
  it('scenario 9: WO plan branch happy path — updates planned_* columns, one plan_changed activity, no domain_events', async () => {
    const base = await seedBaseFixture(pool, `comb-wo-plan-${Date.now()}`);
    const { ticketId, workOrderId } = await seedWorkOrder(pool, base, {
      plannedStartAt: null,
      plannedDurationMinutes: null,
    });

    const idem = `comb-wo-plan-${workOrderId}`;
    const newStart = '2026-09-01T10:00:00Z';
    const result = await runRpcCapture<CombinedResult>(
      pool,
      'public.update_entity_combined',
      [
        'work_order',
        workOrderId,
        base.tenantId,
        null,
        idem,
        { plan: { planned_start_at: newStart, planned_duration_minutes: 60 } },
      ],
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.entity_kind).toBe('work_order');
    expect(result.value.branches_applied).toEqual(['plan']);
    expect(result.value.plan?.changed).toBe(true);
    expect(result.value.plan?.next.planned_duration_minutes).toBe(60);
    expect(result.value.any_changed).toBe(true);

    // work_orders row updated; parent tickets row untouched.
    const wo = await pool.query(
      `select planned_start_at, planned_duration_minutes
         from public.work_orders where id = $1`,
      [workOrderId],
    );
    expect(new Date(wo.rows[0].planned_start_at).toISOString()).toBe(
      new Date(newStart).toISOString(),
    );
    expect(wo.rows[0].planned_duration_minutes).toBe(60);

    const t = await pool.query(
      `select status from public.tickets where id = $1`,
      [ticketId],
    );
    // Sanity: parent row exists, untouched.
    expect(t.rows[0].status).toBe('new');

    // Exactly one activity (plan_changed) on the WO id.
    const acts = await pool.query(
      `select metadata->>'event' as event,
              metadata->'next'->>'planned_duration_minutes' as next_dur
         from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, workOrderId],
    );
    expect(acts.rowCount).toBe(1);
    expect(acts.rows[0].event).toBe('plan_changed');
    expect(acts.rows[0].next_dur).toBe('60');

    // No domain_events — plan is inline, not a sub-RPC.
    const evs = await pool.query(
      `select count(*)::int as n from public.domain_events
        where tenant_id = $1 and entity_id = $2`,
      [base.tenantId, workOrderId],
    );
    expect(evs.rows[0].n).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────
  it('scenario 10: duplicate watcher uuid in metadata input — dedup happy path; persisted set is deduped', async () => {
    // F2 — `[uuidA, uuidA]` must NOT false-reject. The dedup happens
    // before the tenant-membership count check; the persisted set is
    // the deduped one (matches the TS surface's
    // [...new Set(watchers)] at tenant-validation.ts:269).

    const base = await seedBaseFixture(pool, `comb-watch-dedup-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base, { title: 'Orig', watchers: [] });

    // `base.personId` is the seeded requester person; it's already in
    // the tenant so it's a legal watcher. Pass it twice.
    const uuidA = base.personId;

    const idem = `comb-watch-dedup-${ticketId}`;
    const result = await runRpcCapture<CombinedResult>(
      pool,
      'public.update_entity_combined',
      [
        'case',
        ticketId,
        base.tenantId,
        null,
        idem,
        { metadata: { watchers: [uuidA, uuidA] } },
      ],
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.metadata?.changed).toBe(true);
    expect(result.value.any_changed).toBe(true);

    // tickets.watchers persisted as the deduped set (single element).
    const t = await pool.query(
      'select watchers from public.tickets where id = $1',
      [ticketId],
    );
    expect(t.rows[0].watchers).toEqual([uuidA]);

    // Exactly one metadata_changed activity row. The `changes.watchers`
    // diff reports the deduped next set.
    const acts = await pool.query(
      `select metadata->>'event' as event,
              metadata->'changes'->'watchers'->'previous' as prev,
              metadata->'changes'->'watchers'->'next'     as next
         from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(acts.rowCount).toBe(1);
    expect(acts.rows[0].event).toBe('metadata_changed');
    expect(acts.rows[0].prev).toEqual([]);
    expect(acts.rows[0].next).toEqual([uuidA]);
  });

  // ─────────────────────────────────────────────────────────────────────
  it('scenario 11: invalid plan input — bad timestamp raises invalid_plan; no partial writes', async () => {
    // F3 — original 00331 used `nullif(..., '')::timestamptz` which
    // raised raw 22007 (datetime_invalid_format) on a malformed input.
    // v2 type-checks the jsonb value first and raises the registered
    // code instead.

    const base = await seedBaseFixture(pool, `comb-bad-plan-${Date.now()}`);
    const { workOrderId } = await seedWorkOrder(pool, base, {
      plannedStartAt: null,
      plannedDurationMinutes: null,
    });

    const idem = `comb-bad-plan-${workOrderId}`;
    const result = await runRpcCapture<CombinedResult>(
      pool,
      'public.update_entity_combined',
      [
        'work_order',
        workOrderId,
        base.tenantId,
        null,
        idem,
        { plan: { planned_start_at: 'not-an-iso-date' } },
      ],
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toMatch(/update_entity_combined\.invalid_plan/);

    // work_orders row unchanged.
    const wo = await pool.query(
      `select planned_start_at, planned_duration_minutes
         from public.work_orders where id = $1`,
      [workOrderId],
    );
    expect(wo.rows[0].planned_start_at).toBeNull();
    expect(wo.rows[0].planned_duration_minutes).toBeNull();

    // No partial activities; no command_operations row.
    const acts = await pool.query(
      `select count(*)::int as n from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, workOrderId],
    );
    expect(acts.rows[0].n).toBe(0);

    const co = await pool.query(
      `select count(*)::int as n from public.command_operations
        where tenant_id = $1 and idempotency_key = $2`,
      [base.tenantId, idem],
    );
    expect(co.rows[0].n).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────
  it('scenario 12: sla branch happy path — sla_id set, two timers inserted, one activity + one domain event, no outbox', async () => {
    // codex F11 — exercise the SLA sub-RPC through the orchestrator end-
    // to-end. v2's harness covered every other branch but skipped sla.
    const base = await seedBaseFixture(pool, `comb-sla-happy-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const sla = await seedSlaPolicy(pool, base.tenantId);

    const idem = `comb-sla-happy-${ticketId}`;
    const timersPayload = buildTimersPayload(sla);
    const result = await runRpcCapture<CombinedResult>(
      pool,
      'public.update_entity_combined',
      [
        'case',
        ticketId,
        base.tenantId,
        null,
        idem,
        { sla: { sla_id: sla.slaId, timers: timersPayload } },
      ],
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.branches_applied).toEqual(['sla']);
    expect(result.value.any_changed).toBe(true);
    expect(result.value.noop).toBe(false);

    // SLA sub-RPC result shape per 00330:372-379 — no `changed`, only
    // `noop`, `previous_sla_id`, `new_sla_id`, `timers_inserted`.
    const slaSub = result.value.sla as unknown as SlaInnerResult | null;
    expect(slaSub).not.toBeNull();
    expect(slaSub!.noop).toBe(false);
    expect(slaSub!.previous_sla_id).toBeNull();
    expect(slaSub!.new_sla_id).toBe(sla.slaId);
    expect(slaSub!.timers_inserted).toBe(2);

    // tickets row reflects the SLA write.
    const responseDueExpected = timersPayload.find((t) => t.timer_type === 'response')!.due_at;
    const resolutionDueExpected = timersPayload.find((t) => t.timer_type === 'resolution')!.due_at;
    const t = await pool.query(
      `select sla_id, sla_response_due_at, sla_resolution_due_at
         from public.tickets where id = $1`,
      [ticketId],
    );
    expect(t.rows[0].sla_id).toBe(sla.slaId);
    expect(new Date(t.rows[0].sla_response_due_at).toISOString()).toBe(responseDueExpected);
    expect(new Date(t.rows[0].sla_resolution_due_at).toISOString()).toBe(resolutionDueExpected);

    // Two active sla_timers, both with recompute_pending=false.
    const timers = await pool.query(
      `select timer_type, recompute_pending, paused, stopped_at
         from public.sla_timers
        where tenant_id = $1 and ticket_id = $2
          and stopped_at is null and completed_at is null
        order by timer_type`,
      [base.tenantId, ticketId],
    );
    expect(timers.rowCount).toBe(2);
    expect(timers.rows.map((r) => r.timer_type)).toEqual(['resolution', 'response']);
    for (const r of timers.rows) {
      expect(r.recompute_pending).toBe(false);
      expect(r.paused).toBe(false);
    }

    // Exactly one ticket_activities sla_changed row.
    const acts = await pool.query(
      `select metadata->>'event' as event
         from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(acts.rowCount).toBe(1);
    expect(acts.rows[0].event).toBe('sla_changed');

    // Exactly one domain_events row.
    const evs = await pool.query(
      `select event_type from public.domain_events
        where tenant_id = $1 and entity_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(evs.rowCount).toBe(1);
    expect(evs.rows[0].event_type).toBe('ticket_sla_changed');

    // SLA RPC (00330:1-393) does NOT emit outbox events — only
    // domain_events + ticket_activities. Verify zero outbox rows.
    const outbox = await pool.query(
      `select count(*)::int as n from outbox.events
        where tenant_id = $1 and aggregate_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(outbox.rows[0].n).toBe(0);

    // command_operations: outer + sla inner (sentinel prefix per F1).
    const co = await pool.query(
      `select idempotency_key from public.command_operations
        where tenant_id = $1
        order by idempotency_key`,
      [base.tenantId],
    );
    expect(co.rowCount).toBe(2);
    const keys = co.rows.map((r) => r.idempotency_key);
    expect(keys).toContain(idem);
    expect(keys).toContain(`__combined__:sla:case:${ticketId}:${idem}`);
  });

  // ─────────────────────────────────────────────────────────────────────
  it('scenario 13: sla branch idempotent replay — outer cache hit short-circuits; no extra rows', async () => {
    // codex F11 — verify the outer cache path takes precedence when only
    // the sla branch is in patches. Same shape as scenario 2 (priority
    // replay) but exercises the sla sub-RPC's idempotency contract too.
    const base = await seedBaseFixture(pool, `comb-sla-replay-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const sla = await seedSlaPolicy(pool, base.tenantId);

    const idem = `comb-sla-replay-${ticketId}`;
    const patches = { sla: { sla_id: sla.slaId, timers: buildTimersPayload(sla) } };

    const first = await runRpcCapture<CombinedResult>(
      pool,
      'public.update_entity_combined',
      ['case', ticketId, base.tenantId, null, idem, patches],
    );
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect((first.value.sla as unknown as SlaInnerResult).noop).toBe(false);

    const snapshot = {
      timers: (await pool.query(
        `select count(*)::int as n from public.sla_timers
          where tenant_id = $1 and ticket_id = $2`,
        [base.tenantId, ticketId],
      )).rows[0].n as number,
      acts: (await pool.query(
        `select count(*)::int as n from public.ticket_activities
          where tenant_id = $1 and ticket_id = $2`,
        [base.tenantId, ticketId],
      )).rows[0].n as number,
      evs: (await pool.query(
        `select count(*)::int as n from public.domain_events
          where tenant_id = $1 and entity_id = $2`,
        [base.tenantId, ticketId],
      )).rows[0].n as number,
      co: (await pool.query(
        `select count(*)::int as n from public.command_operations where tenant_id = $1`,
        [base.tenantId],
      )).rows[0].n as number,
    };
    expect(snapshot.timers).toBe(2);
    expect(snapshot.acts).toBe(1);
    expect(snapshot.evs).toBe(1);
    // outer + sla inner.
    expect(snapshot.co).toBe(2);

    // Replay — same outer key + same payload.
    const second = await runRpcCapture<CombinedResult>(
      pool,
      'public.update_entity_combined',
      ['case', ticketId, base.tenantId, null, idem, patches],
    );
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.value).toEqual(first.value);

    const after = {
      timers: (await pool.query(
        `select count(*)::int as n from public.sla_timers
          where tenant_id = $1 and ticket_id = $2`,
        [base.tenantId, ticketId],
      )).rows[0].n as number,
      acts: (await pool.query(
        `select count(*)::int as n from public.ticket_activities
          where tenant_id = $1 and ticket_id = $2`,
        [base.tenantId, ticketId],
      )).rows[0].n as number,
      evs: (await pool.query(
        `select count(*)::int as n from public.domain_events
          where tenant_id = $1 and entity_id = $2`,
        [base.tenantId, ticketId],
      )).rows[0].n as number,
      co: (await pool.query(
        `select count(*)::int as n from public.command_operations where tenant_id = $1`,
        [base.tenantId],
      )).rows[0].n as number,
    };
    expect(after).toEqual(snapshot);
  });

  // ─────────────────────────────────────────────────────────────────────
  it('scenario 14: status + sla combined call — branches commit in spec order; documents wasted outbox emit (C3)', async () => {
    // codex F11 — exercises the spec-ordered status→sla interaction.
    //
    // End-state we assert:
    //   • Initial SLA + two active timers (from setup call #1).
    //   • Setup call's outbox row count snapshotted.
    //   • Combined call: status branch sets recompute_pending=true on
    //     active timers AND emits outbox 'sla.timer_recompute_required'
    //     (00325:289-313). SLA branch then stops those timers
    //     (stopped_reason='sla_changed') and inserts fresh ones with
    //     recompute_pending=false.
    //   • After the combined call: 2 stopped timers (slaA) + 2 active
    //     timers (slaB), one extra outbox 'sla.timer_recompute_required'
    //     row (the "wasted" emit per b2-followups.md C3).
    //   • branches_applied contains both 'status' and 'sla'.
    //   • Two ticket_activities rows in this single combined call:
    //     status_changed + sla_changed (in addition to the setup call's
    //     sla_changed).
    const base = await seedBaseFixture(pool, `comb-status-sla-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const slaA = await seedSlaPolicy(pool, base.tenantId, { name: 'slaA' });
    const slaB = await seedSlaPolicy(pool, base.tenantId, { name: 'slaB' });

    // Setup: install slaA with two timers via a separate (non-combined)
    // SLA call so the combined call has pre-existing timers to act on.
    const setupResult = await runRpcCapture<SlaInnerResult>(
      pool,
      'public.update_entity_sla',
      [
        ticketId,
        'case',
        base.tenantId,
        null,
        `comb-status-sla-setup-${ticketId}`,
        { sla_id: slaA.slaId, timers: buildTimersPayload(slaA) },
      ],
    );
    expect(setupResult.kind).toBe('ok');

    // Snapshot outbox count before the combined call.
    const outboxBefore = (await pool.query(
      `select count(*)::int as n from outbox.events
        where tenant_id = $1 and aggregate_id = $2
          and event_type = 'sla.timer_recompute_required'`,
      [base.tenantId, ticketId],
    )).rows[0].n as number;
    expect(outboxBefore).toBe(0);

    // Snapshot the active timer ids — they should be stopped after the
    // combined call's sla branch fires.
    const oldTimers = await pool.query(
      `select id from public.sla_timers
        where tenant_id = $1 and ticket_id = $2
          and stopped_at is null and completed_at is null`,
      [base.tenantId, ticketId],
    );
    expect(oldTimers.rowCount).toBe(2);

    // Combined call: status (waiting/vendor) + sla swap (slaA → slaB).
    const idem = `comb-status-sla-${ticketId}`;
    const timersBPayload = buildTimersPayload(slaB);
    const result = await runRpcCapture<CombinedResult>(
      pool,
      'public.update_entity_combined',
      [
        'case',
        ticketId,
        base.tenantId,
        null,
        idem,
        {
          status_category: 'waiting',
          waiting_reason: 'vendor',
          sla: { sla_id: slaB.slaId, timers: timersBPayload },
        },
      ],
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.branches_applied.sort()).toEqual(['sla', 'status'].sort());
    expect(result.value.any_changed).toBe(true);

    // Old timers (slaA) all stopped with reason='sla_changed'. The
    // recompute_pending flag set by the status branch was on these rows;
    // because the sla branch's UPDATE comes second and includes
    // stopped_at=now()+stopped_reason='sla_changed', the worker will
    // skip them (worker filter: stopped_at IS NULL). The "wasted" emit
    // remains in outbox; that's the documented C3 cosmetic interaction.
    const stoppedOld = await pool.query(
      `select stopped_at, stopped_reason, recompute_pending
         from public.sla_timers
        where id = any($1::uuid[])`,
      [oldTimers.rows.map((r) => r.id)],
    );
    expect(stoppedOld.rowCount).toBe(2);
    for (const row of stoppedOld.rows) {
      expect(row.stopped_at).not.toBeNull();
      expect(row.stopped_reason).toBe('sla_changed');
    }

    // New timers (slaB) — two active rows, recompute_pending=false.
    const newTimers = await pool.query(
      `select timer_type, sla_policy_id, recompute_pending, paused
         from public.sla_timers
        where tenant_id = $1 and ticket_id = $2
          and stopped_at is null and completed_at is null
        order by timer_type`,
      [base.tenantId, ticketId],
    );
    expect(newTimers.rowCount).toBe(2);
    expect(newTimers.rows.every((r) => r.sla_policy_id === slaB.slaId)).toBe(true);
    expect(newTimers.rows.every((r) => r.recompute_pending === false)).toBe(true);
    expect(newTimers.rows.every((r) => r.paused === false)).toBe(true);

    // tickets row reflects slaB.
    const t = await pool.query(
      `select status_category, waiting_reason, sla_id
         from public.tickets where id = $1`,
      [ticketId],
    );
    expect(t.rows[0].status_category).toBe('waiting');
    expect(t.rows[0].waiting_reason).toBe('vendor');
    expect(t.rows[0].sla_id).toBe(slaB.slaId);

    // Both activities present (in addition to setup's sla_changed).
    // Setup row uses a separate ticket_id timing window — count by event.
    const acts = await pool.query(
      `select metadata->>'event' as event
         from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2
        order by created_at`,
      [base.tenantId, ticketId],
    );
    // Three total: setup sla_changed, combined-call status_changed,
    // combined-call sla_changed.
    expect(acts.rowCount).toBe(3);
    const eventCount = acts.rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.event] = (acc[r.event] ?? 0) + 1;
      return acc;
    }, {});
    expect(eventCount.sla_changed).toBe(2);
    expect(eventCount.status_changed).toBe(1);

    // Outbox: status branch emitted one 'sla.timer_recompute_required'
    // during the combined call. Documents the wasted emit (C3).
    const outboxAfter = (await pool.query(
      `select count(*)::int as n from outbox.events
        where tenant_id = $1 and aggregate_id = $2
          and event_type = 'sla.timer_recompute_required'`,
      [base.tenantId, ticketId],
    )).rows[0].n as number;
    expect(outboxAfter).toBe(outboxBefore + 1);
  });

  // ─────────────────────────────────────────────────────────────────────
  it('scenario 15: sla branch nested idempotency — direct call with the inner sentinel key reuses the cache', async () => {
    // codex F11 — verify the inner command_operations row caches the
    // sub-RPC's result and that a direct caller using the orchestrator-
    // derived sentinel-prefixed key gets the cached result back without
    // re-writing rows. Documents the F1 contract: the sentinel
    // `__combined__:` is reserved-by-convention; direct callers minting
    // the same key intentionally collide with (= reuse) the cached
    // inner result.
    const base = await seedBaseFixture(pool, `comb-sla-nested-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const sla = await seedSlaPolicy(pool, base.tenantId);

    const outerIdem = `comb-sla-nested-${ticketId}`;
    const innerKey = `__combined__:sla:case:${ticketId}:${outerIdem}`;
    const slaPayload = { sla_id: sla.slaId, timers: buildTimersPayload(sla) };

    // Step 1: combined call seeds the inner cache via the orchestrator.
    const first = await runRpcCapture<CombinedResult>(
      pool,
      'public.update_entity_combined',
      ['case', ticketId, base.tenantId, null, outerIdem, { sla: slaPayload }],
    );
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect((first.value.sla as unknown as SlaInnerResult).noop).toBe(false);

    // Confirm the inner row exists with cached_result populated.
    const innerBefore = await pool.query(
      `select outcome, cached_result is not null as has_cached
         from public.command_operations
        where tenant_id = $1 and idempotency_key = $2`,
      [base.tenantId, innerKey],
    );
    expect(innerBefore.rowCount).toBe(1);
    expect(innerBefore.rows[0].outcome).toBe('success');
    expect(innerBefore.rows[0].has_cached).toBe(true);

    const snapshot = {
      timers: (await pool.query(
        `select count(*)::int as n from public.sla_timers
          where tenant_id = $1 and ticket_id = $2`,
        [base.tenantId, ticketId],
      )).rows[0].n as number,
      acts: (await pool.query(
        `select count(*)::int as n from public.ticket_activities
          where tenant_id = $1 and ticket_id = $2`,
        [base.tenantId, ticketId],
      )).rows[0].n as number,
      evs: (await pool.query(
        `select count(*)::int as n from public.domain_events
          where tenant_id = $1 and entity_id = $2`,
        [base.tenantId, ticketId],
      )).rows[0].n as number,
      co: (await pool.query(
        `select count(*)::int as n from public.command_operations where tenant_id = $1`,
        [base.tenantId],
      )).rows[0].n as number,
    };
    expect(snapshot.timers).toBe(2);
    expect(snapshot.acts).toBe(1);
    expect(snapshot.evs).toBe(1);
    expect(snapshot.co).toBe(2); // outer + sla inner

    // Step 2: direct call to update_entity_sla using the inner key +
    // same payload. Must hit the inner cache and return without any
    // additional writes.
    const direct = await runRpcCapture<SlaInnerResult>(
      pool,
      'public.update_entity_sla',
      [ticketId, 'case', base.tenantId, null, innerKey, slaPayload],
    );
    expect(direct.kind).toBe('ok');
    if (direct.kind !== 'ok') return;
    // Returned cached_result matches what the orchestrator surfaced
    // back as result.sla.
    expect(direct.value).toEqual(first.value.sla);

    // No new rows.
    const after = {
      timers: (await pool.query(
        `select count(*)::int as n from public.sla_timers
          where tenant_id = $1 and ticket_id = $2`,
        [base.tenantId, ticketId],
      )).rows[0].n as number,
      acts: (await pool.query(
        `select count(*)::int as n from public.ticket_activities
          where tenant_id = $1 and ticket_id = $2`,
        [base.tenantId, ticketId],
      )).rows[0].n as number,
      evs: (await pool.query(
        `select count(*)::int as n from public.domain_events
          where tenant_id = $1 and entity_id = $2`,
        [base.tenantId, ticketId],
      )).rows[0].n as number,
      co: (await pool.query(
        `select count(*)::int as n from public.command_operations where tenant_id = $1`,
        [base.tenantId],
      )).rows[0].n as number,
    };
    expect(after).toEqual(snapshot);
  });
});

export {};
