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
});

export {};
