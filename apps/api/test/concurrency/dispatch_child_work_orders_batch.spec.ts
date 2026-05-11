/**
 * B.2.A.Step8 concurrency probe — dispatch_child_work_orders_batch (§3.4 batch).
 *
 * Spec ref: docs/follow-ups/b2-survey-and-design.md §3.4 (lines 2228-2234).
 * Migration: supabase/migrations/00339_dispatch_child_work_orders_batch_v2.sql.
 *
 * Five scenarios:
 *   1. Batch happy path — 3 tasks → 3 work_orders + 3 routing_decisions
 *      + 3 ticket_activities rows committed in one tx.
 *   2. All-or-nothing — task #2 has a cross-tenant assignee → the ENTIRE
 *      batch rolls back (zero work_orders inserted; tasks #0 and #2 that
 *      would have succeeded on their own also commit NOTHING). F-IMP-3
 *      proves per-task validate_assignees_in_tenant runs inside the loop,
 *      not at the batch boundary.
 *   3. Empty tasks — empty array raises empty_tasks.
 *   4. Idempotent batch replay — same key + same tasks returns
 *      cached_result; row counts unchanged.
 *   5. Mixed sla / no-sla in one batch — only the SLA-bearing task gets
 *      timer rows; v2 (00339) asserts those rows carry
 *      entity_kind='work_order', work_order_id=<task's child_id>, case_id
 *      IS NULL — same F-CRIT-1 guard as the single-RPC harness.
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

interface SeededCase {
  ticketId: string;
}

interface SeededUser {
  userId: string;
  personId: string;
}

interface SeededSla {
  slaId: string;
  responseMinutes: number;
  resolutionMinutes: number;
}

interface BatchResult {
  parent_id: string;
  tenant_id: string;
  tasks: Array<{
    child_id: string;
    status: string;
    status_category: string;
    assigned_team_id: string | null;
    assigned_user_id: string | null;
    assigned_vendor_id: string | null;
    sla_id: string | null;
    routing_chosen_by: string | null;
  }>;
  task_count: number;
  noop: boolean;
}

async function seedCase(pool: Pool, base: { tenantId: string; personId: string }): Promise<SeededCase> {
  const ticketId = randomUUID();
  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      await c.query(
        `insert into public.tickets
           (id, tenant_id, title, status, status_category, priority,
            requester_person_id, source_channel)
         values ($1, $2, 'Concurrency batch parent', 'new', 'new', 'medium', $3, 'system')`,
        [ticketId, base.tenantId, base.personId],
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

async function seedUser(pool: Pool, tenantId: string): Promise<SeededUser> {
  const userId = randomUUID();
  const personId = randomUUID();
  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      await c.query("set local session_replication_role = 'replica'");
      await c.query(
        `insert into public.persons (id, tenant_id, type, first_name, last_name, email)
         values ($1, $2, 'employee', 'Batch', 'Assignee', $3)`,
        [personId, tenantId, `batch-${personId.slice(0, 8)}@concurrency.test`],
      );
      await c.query(
        `insert into public.users (id, tenant_id, auth_uid, email, person_id, status)
         values ($1, $2, $3, $4, $5, 'active')`,
        [userId, tenantId, randomUUID(), `user-${userId.slice(0, 8)}@concurrency.test`, personId],
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
  return { userId, personId };
}

async function seedSla(pool: Pool, tenantId: string): Promise<SeededSla> {
  const slaId = randomUUID();
  await pool.query(
    `insert into public.sla_policies
       (id, tenant_id, name, response_time_minutes, resolution_time_minutes, active)
     values ($1, $2, 'Concurrency batch SLA', 60, 240, true)`,
    [slaId, tenantId],
  );
  return { slaId, responseMinutes: 60, resolutionMinutes: 240 };
}

function buildTimers(sla: SeededSla) {
  const now = new Date();
  return [
    {
      timer_type: 'response',
      target_minutes: sla.responseMinutes,
      due_at: new Date(now.getTime() + sla.responseMinutes * 60_000).toISOString(),
      business_hours_calendar_id: null,
    },
    {
      timer_type: 'resolution',
      target_minutes: sla.resolutionMinutes,
      due_at: new Date(now.getTime() + sla.resolutionMinutes * 60_000).toISOString(),
      business_hours_calendar_id: null,
    },
  ];
}

function buildTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    child_id: randomUUID(),
    title: 'Batch task',
    description: null,
    priority: 'medium',
    interaction_mode: 'internal',
    routing_trace: [],
    routing_chosen_by: 'manual',
    routing_strategy: 'manual',
    ...overrides,
  };
}

describe('dispatch_child_work_orders_batch — §3.4 batch RPC', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = getPool();
  });

  afterAll(async () => {
    await flushAllFixtures(pool);
    await endPool();
  });

  // ────────────────────────────────────────────────────────────────────
  it('scenario 1: happy path — 3 tasks → 3 work_orders + 3 routing_decisions + 3 activities in one tx', async () => {
    const base = await seedBaseFixture(pool, `batch-happy-${Date.now()}`);
    const { ticketId: parentId } = await seedCase(pool, base);
    const u1 = await seedUser(pool, base.tenantId);
    const u2 = await seedUser(pool, base.tenantId);

    const tasks = [
      buildTask({ title: 'task-1', assigned_user_id: u1.userId }),
      buildTask({ title: 'task-2', assigned_user_id: u2.userId }),
      buildTask({ title: 'task-3' }),
    ];

    // pg's default array serializer converts JS arrays to PostgreSQL
    // array literals — not JSON. Stringify so the value lands in a
    // text param and the function's jsonb cast handles it cleanly.
    const result = await runRpcCapture<BatchResult>(
      pool, 'public.dispatch_child_work_orders_batch',
      [parentId, base.tenantId, null, `dispatch_batch:happy:${parentId}`, JSON.stringify(tasks)],
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.task_count).toBe(3);
    expect(result.value.tasks).toHaveLength(3);

    const wo = await pool.query(
      `select count(*) as n from public.work_orders
         where tenant_id = $1 and parent_ticket_id = $2`,
      [base.tenantId, parentId],
    );
    expect(Number(wo.rows[0].n)).toBe(3);

    const rd = await pool.query(
      `select count(*) as n from public.routing_decisions
         where tenant_id = $1 and entity_kind = 'work_order'`,
      [base.tenantId],
    );
    expect(Number(rd.rows[0].n)).toBe(3);

    const act = await pool.query(
      `select count(*) as n, count(*) filter (where metadata->>'event' = 'dispatched') as dispatched
         from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, parentId],
    );
    expect(Number(act.rows[0].dispatched)).toBe(3);
  });

  // ────────────────────────────────────────────────────────────────────
  it('scenario 2: all-or-nothing — one task with cross-tenant assignee rolls back the ENTIRE batch', async () => {
    const baseA = await seedBaseFixture(pool, `batch-aon-A-${Date.now()}`);
    const baseB = await seedBaseFixture(pool, `batch-aon-B-${Date.now()}`);
    const { ticketId: parentId } = await seedCase(pool, baseA);
    const okUser = await seedUser(pool, baseA.tenantId);
    const foreignUser = await seedUser(pool, baseB.tenantId);

    const tasks = [
      buildTask({ title: 'aon-1', assigned_user_id: okUser.userId }),
      buildTask({ title: 'aon-2', assigned_user_id: foreignUser.userId }), // POISON
      buildTask({ title: 'aon-3', assigned_user_id: okUser.userId }),
    ];

    const result = await runRpcCapture<BatchResult>(
      pool, 'public.dispatch_child_work_orders_batch',
      [parentId, baseA.tenantId, null, `dispatch_batch:aon:${parentId}`, JSON.stringify(tasks)],
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toMatch(/validate_assignees_in_tenant\.assigned_user_id_not_in_tenant/);

    // ZERO partial commits — even task #1 (which would have succeeded
    // on its own) must NOT have written a row.
    const wo = await pool.query(
      `select count(*) as n from public.work_orders
         where tenant_id = $1 and parent_ticket_id = $2`,
      [baseA.tenantId, parentId],
    );
    expect(Number(wo.rows[0].n)).toBe(0);

    const rd = await pool.query(
      `select count(*) as n from public.routing_decisions
         where tenant_id = $1 and entity_kind = 'work_order'`,
      [baseA.tenantId],
    );
    expect(Number(rd.rows[0].n)).toBe(0);

    const act = await pool.query(
      `select count(*) as n from public.ticket_activities
         where tenant_id = $1 and ticket_id = $2`,
      [baseA.tenantId, parentId],
    );
    expect(Number(act.rows[0].n)).toBe(0);
  });

  // ────────────────────────────────────────────────────────────────────
  it('scenario 3: empty tasks array raises empty_tasks', async () => {
    const base = await seedBaseFixture(pool, `batch-empty-${Date.now()}`);
    const { ticketId: parentId } = await seedCase(pool, base);

    const result = await runRpcCapture<BatchResult>(
      pool, 'public.dispatch_child_work_orders_batch',
      [parentId, base.tenantId, null, `dispatch_batch:empty:${parentId}`, JSON.stringify([])],
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toMatch(/dispatch_child_work_orders_batch\.empty_tasks/);
  });

  // ────────────────────────────────────────────────────────────────────
  it('scenario 4: idempotent batch replay — same key + same tasks returns cached_result; row counts unchanged', async () => {
    const base = await seedBaseFixture(pool, `batch-idem-${Date.now()}`);
    const { ticketId: parentId } = await seedCase(pool, base);
    const u1 = await seedUser(pool, base.tenantId);

    const tasks = [
      buildTask({ title: 'idem-1', assigned_user_id: u1.userId }),
      buildTask({ title: 'idem-2' }),
    ];
    const idem = `dispatch_batch:idem:${parentId}`;

    const a = await runRpcCapture<BatchResult>(
      pool, 'public.dispatch_child_work_orders_batch',
      [parentId, base.tenantId, null, idem, JSON.stringify(tasks)],
    );
    expect(a.kind).toBe('ok');
    const b = await runRpcCapture<BatchResult>(
      pool, 'public.dispatch_child_work_orders_batch',
      [parentId, base.tenantId, null, idem, JSON.stringify(tasks)],
    );
    expect(b.kind).toBe('ok');
    if (a.kind !== 'ok' || b.kind !== 'ok') return;
    expect(b.value.task_count).toBe(2);

    const wo = await pool.query(
      `select count(*) as n from public.work_orders
         where tenant_id = $1 and parent_ticket_id = $2`,
      [base.tenantId, parentId],
    );
    expect(Number(wo.rows[0].n)).toBe(2);

    const act = await pool.query(
      `select count(*) as n from public.ticket_activities
         where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, parentId],
    );
    expect(Number(act.rows[0].n)).toBe(2);
  });

  // ────────────────────────────────────────────────────────────────────
  it('scenario 5: mixed sla / no-sla in one batch — only the sla-bearing task gets timer rows', async () => {
    const base = await seedBaseFixture(pool, `batch-mixed-${Date.now()}`);
    const { ticketId: parentId } = await seedCase(pool, base);
    const sla = await seedSla(pool, base.tenantId);

    const slaTask = buildTask({
      title: 'with-sla',
      sla_id: sla.slaId,
      timers: buildTimers(sla),
    });
    const noSlaTask = buildTask({ title: 'no-sla' });
    // No sla_id key at all — same as the production "no sla" path.
    delete (noSlaTask as { sla_id?: unknown }).sla_id;

    const result = await runRpcCapture<BatchResult>(
      pool, 'public.dispatch_child_work_orders_batch',
      [parentId, base.tenantId, null, `dispatch_batch:mixed:${parentId}`, JSON.stringify([slaTask, noSlaTask])],
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const slaChildId = slaTask.child_id as string;
    const noSlaChildId = noSlaTask.child_id as string;

    const slaTimers = await pool.query(
      `select timer_type, entity_kind, case_id, work_order_id, started_at
         from public.sla_timers
         where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, slaChildId],
    );
    expect(slaTimers.rowCount).toBe(2);
    // F-CRIT-1: polymorphic columns populated on every batch-emitted
    // timer (mirror of 00330:259-277). Catches the silent read-side
    // regression where 00337 v1 omitted these columns.
    for (const r of slaTimers.rows) {
      expect(r.entity_kind).toBe('work_order');
      expect(r.work_order_id).toBe(slaChildId);
      expect(r.case_id).toBeNull();
      expect(r.started_at).not.toBeNull();
    }

    const noSlaTimers = await pool.query(
      `select count(*) as n from public.sla_timers
         where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, noSlaChildId],
    );
    expect(Number(noSlaTimers.rows[0].n)).toBe(0);

    // Mirror columns: sla task has due_ats; no-sla task does not.
    const slaWo = await pool.query(
      `select sla_id, sla_response_due_at, sla_resolution_due_at
         from public.work_orders where id = $1`,
      [slaChildId],
    );
    expect(slaWo.rows[0].sla_id).toBe(sla.slaId);
    expect(slaWo.rows[0].sla_response_due_at).not.toBeNull();

    const noSlaWo = await pool.query(
      `select sla_id, sla_response_due_at, sla_resolution_due_at
         from public.work_orders where id = $1`,
      [noSlaChildId],
    );
    expect(noSlaWo.rows[0].sla_id).toBeNull();
    expect(noSlaWo.rows[0].sla_response_due_at).toBeNull();
  });
});
