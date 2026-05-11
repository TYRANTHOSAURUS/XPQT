/**
 * B.2.A.Step8 concurrency probe — dispatch_child_work_order (§3.4 single).
 *
 * Spec ref: docs/follow-ups/b2-survey-and-design.md §3.4 (lines 2165-2226).
 * Migration: supabase/migrations/00338_dispatch_child_work_order_v2.sql.
 *
 * Nine scenarios, all against the live local Supabase stack:
 *   1. Single-task happy path — child work_order inserted with sla,
 *      assignment, routing trace; ticket_activities row on parent;
 *      sla_timers rows + mirror onto work_orders.sla_*_due_at.
 *      v2 (00338) asserts: entity_kind='work_order',
 *      work_order_id=<child_id>, case_id IS NULL on every inserted timer
 *      (catches F-CRIT-1 silent regression).
 *   2. Idempotent replay — same key + same payload returns cached_result
 *      with no extra rows in work_orders / routing_decisions /
 *      sla_timers / ticket_activities.
 *   3. Payload mismatch — same key + different payload raises
 *      'command_operations.payload_mismatch'.
 *   4. Parent not found — bogus parent uuid raises
 *      'dispatch_child_work_order.parent_not_found'.
 *   5. Parent pending_approval — pre-seeded parent in pending_approval;
 *      raises 'dispatch_child_work_order.parent_not_dispatchable'.
 *   6. Parent terminal — pre-seeded parent in 'closed'; raises
 *      'dispatch_child_work_order.parent_not_dispatchable'.
 *   7. Parent kind != 'case' — work_order id passed as parent; raises
 *      'dispatch_child_work_order.parent_not_found' (the parent SELECT
 *      is on public.tickets which only holds case rows post step1c.10c;
 *      a work_order id will miss). The registered code
 *      'dispatch_child_work_order.parent_not_case' was DROPPED in the
 *      Step 8 self-review remediation (F-IMP-2 / plan-I2) — unreachable
 *      dead code.
 *   8. Cross-tenant assignee — parent in TENANT_A, payload assignee
 *      from TENANT_B → validate_assignees_in_tenant raises 42501
 *      'validate_assignees_in_tenant.assigned_user_id_not_in_tenant'.
 *      F-IMP-4 / code-I1: the helper's 3 raised codes are now
 *      REGISTERED in `packages/shared/src/error-codes.ts` so the
 *      mapRpcErrorToAppError path produces a clean 422 (was 500
 *      `unknown.server_error` fall-through pre-remediation).
 *   9. Sla_id null path — payload omits sla_id; no timer rows inserted;
 *      child created, routing_decisions + parent activity both present.
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
  authUid: string;
  personId: string;
}

interface SeededSla {
  slaId: string;
  responseMinutes: number;
  resolutionMinutes: number;
}

interface DispatchResult {
  child_id: string;
  parent_id: string;
  tenant_id: string;
  status: string;
  status_category: string;
  assigned_team_id: string | null;
  assigned_user_id: string | null;
  assigned_vendor_id: string | null;
  sla_id: string | null;
  routing_chosen_by: string | null;
  noop: boolean;
}

async function seedCase(
  pool: Pool,
  base: { tenantId: string; personId: string },
  opts: { statusCategory?: string } = {},
): Promise<SeededCase> {
  const ticketId = randomUUID();
  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      await c.query(
        `insert into public.tickets
           (id, tenant_id, title, status, status_category,
            priority, requester_person_id, source_channel)
         values ($1, $2, 'Concurrency dispatch parent', 'new', $3,
                 'medium', $4, 'system')`,
        [ticketId, base.tenantId, opts.statusCategory ?? 'new', base.personId],
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
  const authUid = randomUUID();
  const personId = randomUUID();
  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      await c.query("set local session_replication_role = 'replica'");
      await c.query(
        `insert into public.persons (id, tenant_id, type, first_name, last_name, email)
         values ($1, $2, 'employee', 'Dispatch', 'Assignee', $3)`,
        [personId, tenantId, `disp-${personId.slice(0, 8)}@concurrency.test`],
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

async function seedSla(pool: Pool, tenantId: string): Promise<SeededSla> {
  const slaId = randomUUID();
  const responseMinutes = 60;
  const resolutionMinutes = 240;
  await pool.query(
    `insert into public.sla_policies
       (id, tenant_id, name, response_time_minutes, resolution_time_minutes, active)
     values ($1, $2, 'Concurrency dispatch SLA', $3, $4, true)`,
    [slaId, tenantId, responseMinutes, resolutionMinutes],
  );
  return { slaId, responseMinutes, resolutionMinutes };
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

function buildPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    child_id: randomUUID(),
    title: 'Dispatch probe child',
    description: null,
    priority: 'medium',
    interaction_mode: 'internal',
    routing_trace: [],
    routing_chosen_by: 'manual',
    routing_strategy: 'manual',
    ...overrides,
  };
}

describe('dispatch_child_work_order — §3.4 single-child RPC', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = getPool();
  });

  afterAll(async () => {
    await flushAllFixtures(pool);
    await endPool();
  });

  // ────────────────────────────────────────────────────────────────────
  it('scenario 1: happy path — child + routing audit + sla timers + parent activity all commit', async () => {
    const base = await seedBaseFixture(pool, `disp-happy-${Date.now()}`);
    const { ticketId: parentId } = await seedCase(pool, base);
    const assignee = await seedUser(pool, base.tenantId);
    const sla = await seedSla(pool, base.tenantId);

    const payload = buildPayload({
      assigned_user_id: assignee.userId,
      sla_id: sla.slaId,
      timers: buildTimers(sla),
    });
    const idem = `dispatch:happy:${parentId}`;

    const result = await runRpcCapture<DispatchResult>(
      pool,
      'public.dispatch_child_work_order',
      [parentId, base.tenantId, null, idem, payload],
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.child_id).toBe(payload.child_id);
    expect(result.value.status_category).toBe('assigned');
    expect(result.value.assigned_user_id).toBe(assignee.userId);
    expect(result.value.sla_id).toBe(sla.slaId);

    const wo = await pool.query(
      `select id, parent_kind, parent_ticket_id, sla_id,
              assigned_user_id, status, status_category,
              sla_response_due_at, sla_resolution_due_at
         from public.work_orders where id = $1`,
      [payload.child_id],
    );
    expect(wo.rows[0].parent_kind).toBe('case');
    expect(wo.rows[0].parent_ticket_id).toBe(parentId);
    expect(wo.rows[0].sla_id).toBe(sla.slaId);
    expect(wo.rows[0].sla_response_due_at).not.toBeNull();
    expect(wo.rows[0].sla_resolution_due_at).not.toBeNull();

    const rd = await pool.query(
      `select entity_kind, work_order_id, case_id, chosen_user_id
         from public.routing_decisions
        where tenant_id = $1 and work_order_id = $2`,
      [base.tenantId, payload.child_id],
    );
    expect(rd.rowCount).toBe(1);
    expect(rd.rows[0].entity_kind).toBe('work_order');
    expect(rd.rows[0].chosen_user_id).toBe(assignee.userId);

    const timers = await pool.query(
      `select timer_type, entity_kind, case_id, work_order_id, started_at
         from public.sla_timers
         where tenant_id = $1 and ticket_id = $2
         order by timer_type`,
      [base.tenantId, payload.child_id],
    );
    expect(timers.rows.map((r) => r.timer_type)).toEqual(['resolution', 'response']);
    // F-CRIT-1: assert polymorphic columns are populated on every row so
    // entity-aware reads (filtering by entity_kind='work_order' AND
    // work_order_id=X) hit dispatch-emitted timers. Mirror of
    // 00330:259-277 (canonical sla_timers INSERT shape).
    for (const r of timers.rows) {
      expect(r.entity_kind).toBe('work_order');
      expect(r.work_order_id).toBe(payload.child_id);
      expect(r.case_id).toBeNull();
      expect(r.started_at).not.toBeNull();
    }

    const act = await pool.query(
      `select metadata->>'event' as event, metadata->>'child_id' as child_id
         from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, parentId],
    );
    expect(act.rowCount).toBe(1);
    expect(act.rows[0].event).toBe('dispatched');
    expect(act.rows[0].child_id).toBe(payload.child_id);
  });

  // ────────────────────────────────────────────────────────────────────
  it('scenario 2: idempotent replay — same key + same payload returns cached_result with no extra rows', async () => {
    const base = await seedBaseFixture(pool, `disp-idem-${Date.now()}`);
    const { ticketId: parentId } = await seedCase(pool, base);
    const assignee = await seedUser(pool, base.tenantId);

    const payload = buildPayload({ assigned_user_id: assignee.userId });
    const idem = `dispatch:idem:${parentId}`;

    const a = await runRpcCapture<DispatchResult>(
      pool, 'public.dispatch_child_work_order',
      [parentId, base.tenantId, null, idem, payload],
    );
    expect(a.kind).toBe('ok');
    const b = await runRpcCapture<DispatchResult>(
      pool, 'public.dispatch_child_work_order',
      [parentId, base.tenantId, null, idem, payload],
    );
    expect(b.kind).toBe('ok');
    if (a.kind !== 'ok' || b.kind !== 'ok') return;
    expect(b.value.child_id).toBe(a.value.child_id); // deterministic id replay

    const wo = await pool.query(
      `select count(*) as n from public.work_orders
         where tenant_id = $1 and parent_ticket_id = $2`,
      [base.tenantId, parentId],
    );
    expect(Number(wo.rows[0].n)).toBe(1);

    const rd = await pool.query(
      `select count(*) as n from public.routing_decisions
         where tenant_id = $1 and work_order_id = $2`,
      [base.tenantId, a.value.child_id],
    );
    expect(Number(rd.rows[0].n)).toBe(1);

    const act = await pool.query(
      `select count(*) as n from public.ticket_activities
         where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, parentId],
    );
    expect(Number(act.rows[0].n)).toBe(1);
  });

  // ────────────────────────────────────────────────────────────────────
  it('scenario 3: payload mismatch — same key + different payload raises command_operations.payload_mismatch', async () => {
    const base = await seedBaseFixture(pool, `disp-mismatch-${Date.now()}`);
    const { ticketId: parentId } = await seedCase(pool, base);
    const assignee = await seedUser(pool, base.tenantId);

    const idem = `dispatch:mismatch:${parentId}`;
    const a = await runRpcCapture<DispatchResult>(
      pool, 'public.dispatch_child_work_order',
      [parentId, base.tenantId, null, idem, buildPayload({ assigned_user_id: assignee.userId, title: 'first' })],
    );
    expect(a.kind).toBe('ok');

    const b = await runRpcCapture<DispatchResult>(
      pool, 'public.dispatch_child_work_order',
      [parentId, base.tenantId, null, idem, buildPayload({ assigned_user_id: assignee.userId, title: 'second' })],
    );
    expect(b.kind).toBe('error');
    if (b.kind !== 'error') return;
    expect(b.error.message).toMatch(/command_operations\.payload_mismatch/);
  });

  // ────────────────────────────────────────────────────────────────────
  it('scenario 4: parent not found — bogus parent uuid raises parent_not_found', async () => {
    const base = await seedBaseFixture(pool, `disp-nf-${Date.now()}`);
    const bogus = randomUUID();
    const result = await runRpcCapture<DispatchResult>(
      pool, 'public.dispatch_child_work_order',
      [bogus, base.tenantId, null, `dispatch:nf:${bogus}`, buildPayload()],
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toMatch(/dispatch_child_work_order\.parent_not_found/);
  });

  // ────────────────────────────────────────────────────────────────────
  it('scenario 5: parent pending_approval — raises parent_not_dispatchable', async () => {
    const base = await seedBaseFixture(pool, `disp-pa-${Date.now()}`);
    const { ticketId: parentId } = await seedCase(pool, base, { statusCategory: 'pending_approval' });

    const result = await runRpcCapture<DispatchResult>(
      pool, 'public.dispatch_child_work_order',
      [parentId, base.tenantId, null, `dispatch:pa:${parentId}`, buildPayload()],
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toMatch(/dispatch_child_work_order\.parent_not_dispatchable/);
  });

  // ────────────────────────────────────────────────────────────────────
  it('scenario 6: parent terminal (closed) — raises parent_not_dispatchable', async () => {
    const base = await seedBaseFixture(pool, `disp-term-${Date.now()}`);
    const { ticketId: parentId } = await seedCase(pool, base, { statusCategory: 'closed' });

    const result = await runRpcCapture<DispatchResult>(
      pool, 'public.dispatch_child_work_order',
      [parentId, base.tenantId, null, `dispatch:term:${parentId}`, buildPayload()],
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toMatch(/dispatch_child_work_order\.parent_not_dispatchable/);
  });

  // ────────────────────────────────────────────────────────────────────
  it('scenario 7: parent id pointing at a work_order (not a case) → parent_not_found (tickets table only holds cases)', async () => {
    const base = await seedBaseFixture(pool, `disp-wo-${Date.now()}`);
    const { ticketId: parentId } = await seedCase(pool, base);
    // Insert a work_order under that parent so we have a wo id to misuse.
    const woId = randomUUID();
    await pool.query(
      `insert into public.work_orders
         (id, tenant_id, parent_kind, parent_ticket_id, title, status, status_category, priority, source_channel)
       values ($1, $2, 'case', $3, 'wo-misuse', 'new', 'new', 'medium', 'system')`,
      [woId, base.tenantId, parentId],
    );

    const result = await runRpcCapture<DispatchResult>(
      pool, 'public.dispatch_child_work_order',
      [woId, base.tenantId, null, `dispatch:wo:${woId}`, buildPayload()],
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    // public.tickets only holds case rows post step1c.10c — a work_order
    // id misses the SELECT entirely. parent_not_found is the registered
    // code that surfaces. F-IMP-2 / plan-I2: parent_not_case was DROPPED
    // from the registry (unreachable dead code).
    expect(result.error.message).toMatch(/dispatch_child_work_order\.parent_not_found/);
  });

  // ────────────────────────────────────────────────────────────────────
  it('scenario 8: cross-tenant assignee — TENANT_A parent + TENANT_B user → assignee tenant validation rejects', async () => {
    const baseA = await seedBaseFixture(pool, `disp-xtA-${Date.now()}`);
    const baseB = await seedBaseFixture(pool, `disp-xtB-${Date.now()}`);
    const { ticketId: parentId } = await seedCase(pool, baseA);
    const assigneeB = await seedUser(pool, baseB.tenantId);

    const payload = buildPayload({ assigned_user_id: assigneeB.userId });
    const result = await runRpcCapture<DispatchResult>(
      pool, 'public.dispatch_child_work_order',
      [parentId, baseA.tenantId, null, `dispatch:xt:${parentId}`, payload],
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    // F-IMP-4 / code-I1: helper's raise message shape preserved across
    // remediation; the code is now REGISTERED so mapRpcErrorToAppError
    // produces a clean AppError(422) instead of falling through to 500.
    expect(result.error.message).toMatch(/validate_assignees_in_tenant\.assigned_user_id_not_in_tenant/);

    // No partial writes.
    const wo = await pool.query(
      `select count(*) as n from public.work_orders where tenant_id = $1 and parent_ticket_id = $2`,
      [baseA.tenantId, parentId],
    );
    expect(Number(wo.rows[0].n)).toBe(0);
  });

  // ────────────────────────────────────────────────────────────────────
  it('scenario 9: sla_id null path — payload omits sla_id; no timer rows; child + routing audit + activity present', async () => {
    const base = await seedBaseFixture(pool, `disp-nosla-${Date.now()}`);
    const { ticketId: parentId } = await seedCase(pool, base);
    const assignee = await seedUser(pool, base.tenantId);

    // Build a payload with NO sla_id key at all (NOT { sla_id: null }).
    const payload = buildPayload({ assigned_user_id: assignee.userId });
    delete (payload as { sla_id?: unknown }).sla_id;

    const result = await runRpcCapture<DispatchResult>(
      pool, 'public.dispatch_child_work_order',
      [parentId, base.tenantId, null, `dispatch:nosla:${parentId}`, payload],
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.sla_id).toBeNull();

    const timers = await pool.query(
      `select count(*) as n from public.sla_timers where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, result.value.child_id],
    );
    expect(Number(timers.rows[0].n)).toBe(0);

    const wo = await pool.query(
      `select sla_id, sla_response_due_at, sla_resolution_due_at from public.work_orders where id = $1`,
      [result.value.child_id],
    );
    expect(wo.rows[0].sla_id).toBeNull();
    expect(wo.rows[0].sla_response_due_at).toBeNull();
    expect(wo.rows[0].sla_resolution_due_at).toBeNull();

    // Routing + activity still emitted.
    const rd = await pool.query(
      `select count(*) as n from public.routing_decisions where work_order_id = $1`,
      [result.value.child_id],
    );
    expect(Number(rd.rows[0].n)).toBe(1);

    const act = await pool.query(
      `select count(*) as n from public.ticket_activities where ticket_id = $1`,
      [parentId],
    );
    expect(Number(act.rows[0].n)).toBe(1);
  });
});
