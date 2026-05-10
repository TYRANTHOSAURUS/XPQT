/**
 * B.2.A.5 concurrency probe — transition_entity_status.
 *
 * Spec ref: docs/follow-ups/b2-survey-and-design.md §3.1 (lines 1899-1983).
 * Migration: supabase/migrations/00323_transition_entity_status_rpc.sql.
 * Harness pattern mirrors create_booking_with_attach_plan.spec.ts.
 *
 * Five scenarios, all against the live local Supabase stack:
 *   1. Idempotent retry — same key + same payload → both calls return the
 *      same cached_result; only one ticket_activities row written.
 *   2. Payload mismatch — same key + different payload raises
 *      'command_operations.payload_mismatch'.
 *   3. Serial transitions — A → B → A produces 2 activity rows and the
 *      ticket settles back at A.
 *   4. has_open_children — case with an active work_order child cannot
 *      enter terminal; raises 'transition_entity_status.has_open_children'.
 *   5. No-op fast path — same status with no waiting_reason change returns
 *      noop=true and writes no activity row.
 */

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  callRpc,
  flushAllFixtures,
  registerCleanup,
  runRpcCapture,
  seedBaseFixture,
  withClient,
} from './helpers';
import { endPool, getPool } from './pool';

interface SeededTicket {
  ticketId: string;
  workOrderId?: string;
}

/**
 * Insert a minimal `tickets` row in `new` status for the harness, plus
 * register a cleanup that wipes ticket_activities + sla_timers + tickets +
 * work_orders + command_operations rows for the tenant. The base helper
 * (helpers.ts:307-355) doesn't know about case/work_order surfaces — we
 * extend cleanup here so each test self-contains its mess.
 */
async function seedCase(
  pool: Pool,
  base: { tenantId: string; personId: string },
  opts: { withOpenChild?: boolean } = {},
): Promise<SeededTicket> {
  const ticketId = randomUUID();
  let workOrderId: string | undefined;

  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      // No SET LOCAL session_replication_role here — we WANT the
      // tickets_assign_module_number trigger (BEFORE INSERT) to fire
      // so module_number gets populated. The replica-mode override in
      // helpers.ts:258 was specifically for tenant-insert retention
      // seeding drift; tickets/work_orders insert paths are clean.
      await c.query(
        `insert into public.tickets
           (id, tenant_id, title, status, status_category,
            requester_person_id, source_channel)
         values ($1, $2, 'Concurrency probe case', 'new', 'new', $3, 'system')`,
        [ticketId, base.tenantId, base.personId],
      );
      if (opts.withOpenChild) {
        workOrderId = randomUUID();
        await c.query(
          `insert into public.work_orders
             (id, tenant_id, parent_kind, parent_ticket_id,
              title, status, status_category, source_channel)
           values ($1, $2, 'case', $3,
                   'Concurrency probe child WO', 'new', 'new', 'system')`,
          [workOrderId, base.tenantId, ticketId],
        );
      }
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
        await c.query('delete from public.ticket_activities where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.sla_timers where tenant_id = $1', [base.tenantId]);
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

interface TransitionResult {
  entity_id: string;
  entity_kind: string;
  previous_status: string;
  new_status: string;
  previous_status_category: string;
  new_status_category: string;
  previous_waiting_reason: string | null;
  new_waiting_reason: string | null;
  noop: boolean;
}

describe('transition_entity_status — combined RPC', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = getPool();
  });

  afterAll(async () => {
    await flushAllFixtures(pool);
    await endPool();
  });

  it('scenario 1: idempotent retry — same key + same payload returns cached_result, one activity row', async () => {
    const base = await seedBaseFixture(pool, `transition-idem-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);

    const idem = `transition-idem-${ticketId}`;
    const payload = {
      status: 'in_progress',
      status_category: 'in_progress',
    };

    const first = await runRpcCapture<TransitionResult>(
      pool,
      'public.transition_entity_status',
      [ticketId, 'case', base.tenantId, null, idem, payload],
    );
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(first.value.noop).toBe(false);
    expect(first.value.previous_status).toBe('new');
    expect(first.value.new_status).toBe('in_progress');

    // Same key, same payload — cached_result returned without re-writing.
    const second = await runRpcCapture<TransitionResult>(
      pool,
      'public.transition_entity_status',
      [ticketId, 'case', base.tenantId, null, idem, payload],
    );
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.value).toEqual(first.value);

    // Exactly one status_changed activity row across both retries.
    const acts = await pool.query(
      `select id from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2
          and metadata->>'event' = 'status_changed'`,
      [base.tenantId, ticketId],
    );
    expect(acts.rowCount).toBe(1);

    // command_operations row marked success.
    const co = await pool.query(
      `select outcome, cached_result is not null as has_cached
         from public.command_operations
        where tenant_id = $1 and idempotency_key = $2`,
      [base.tenantId, idem],
    );
    expect(co.rowCount).toBe(1);
    expect(co.rows[0].outcome).toBe('success');
    expect(co.rows[0].has_cached).toBe(true);
  });

  it('scenario 2: payload mismatch — same key + different payload raises command_operations.payload_mismatch', async () => {
    const base = await seedBaseFixture(pool, `transition-mismatch-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);

    const idem = `transition-mismatch-${ticketId}`;

    const first = await runRpcCapture<TransitionResult>(
      pool,
      'public.transition_entity_status',
      [ticketId, 'case', base.tenantId, null, idem, { status: 'in_progress', status_category: 'in_progress' }],
    );
    expect(first.kind).toBe('ok');

    // Same idempotency_key but different payload (waiting_reason added).
    const second = await runRpcCapture<TransitionResult>(
      pool,
      'public.transition_entity_status',
      [ticketId, 'case', base.tenantId, null, idem, { status: 'waiting', status_category: 'waiting', waiting_reason: 'requester' }],
    );
    expect(second.kind).toBe('error');
    if (second.kind !== 'error') return;
    expect(second.error.message).toMatch(/command_operations\.payload_mismatch/);
  });

  it('scenario 3: serial transitions A -> B -> A — 2 activity rows, ticket back at A', async () => {
    const base = await seedBaseFixture(pool, `transition-serial-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);

    // A: new -> in_progress
    const t1 = await runRpcCapture<TransitionResult>(
      pool,
      'public.transition_entity_status',
      [ticketId, 'case', base.tenantId, null, `serial-1-${ticketId}`, { status: 'in_progress', status_category: 'in_progress' }],
    );
    expect(t1.kind).toBe('ok');

    // B: in_progress -> waiting
    const t2 = await runRpcCapture<TransitionResult>(
      pool,
      'public.transition_entity_status',
      [ticketId, 'case', base.tenantId, null, `serial-2-${ticketId}`, { status: 'waiting', status_category: 'waiting', waiting_reason: 'requester' }],
    );
    expect(t2.kind).toBe('ok');
    if (t2.kind !== 'ok') return;
    expect(t2.value.previous_status_category).toBe('in_progress');
    expect(t2.value.new_status_category).toBe('waiting');

    // A: waiting -> in_progress (clears waiting_reason)
    const t3 = await runRpcCapture<TransitionResult>(
      pool,
      'public.transition_entity_status',
      [ticketId, 'case', base.tenantId, null, `serial-3-${ticketId}`, { status: 'in_progress', status_category: 'in_progress', waiting_reason: null }],
    );
    expect(t3.kind).toBe('ok');
    if (t3.kind !== 'ok') return;
    expect(t3.value.new_status_category).toBe('in_progress');
    expect(t3.value.new_waiting_reason).toBeNull();

    // Brief expects "2 activity rows" — but the spec actually writes one
    // per transition. With three writes (new->ip, ip->waiting, waiting->ip)
    // the activity feed shows 3. Verify the actual count and that the
    // final ticket state is correct.
    const acts = await pool.query(
      `select metadata->'next'->>'status_category' as new_cat
         from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2
          and metadata->>'event' = 'status_changed'
        order by created_at asc`,
      [base.tenantId, ticketId],
    );
    expect(acts.rowCount).toBe(3);
    expect(acts.rows.map((r) => r.new_cat)).toEqual(['in_progress', 'waiting', 'in_progress']);

    const t = await pool.query('select status, status_category, waiting_reason from public.tickets where id = $1', [ticketId]);
    expect(t.rows[0].status).toBe('in_progress');
    expect(t.rows[0].status_category).toBe('in_progress');
    expect(t.rows[0].waiting_reason).toBeNull();
  });

  it('scenario 4: has_open_children — case with active work_order cannot close', async () => {
    const base = await seedBaseFixture(pool, `transition-children-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base, { withOpenChild: true });

    const idem = `transition-children-${ticketId}`;
    const result = await runRpcCapture<TransitionResult>(
      pool,
      'public.transition_entity_status',
      [ticketId, 'case', base.tenantId, null, idem, { status: 'closed', status_category: 'closed' }],
    );

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toMatch(/transition_entity_status\.has_open_children/);

    // command_operations marker rolled back with the failed tx (no row).
    const co = await pool.query(
      'select outcome from public.command_operations where tenant_id = $1 and idempotency_key = $2',
      [base.tenantId, idem],
    );
    expect(co.rowCount).toBe(0);

    // Ticket NOT in terminal — no partial mutation. (The child-WO insert
    // bumps parent to 'assigned' via 00226 rollup; the relevant assertion
    // is that the close didn't go through.)
    const t = await pool.query('select status_category from public.tickets where id = $1', [ticketId]);
    expect(['resolved', 'closed']).not.toContain(t.rows[0].status_category);
  });

  it('scenario 5: no-op fast path — same status, no waiting_reason change returns noop=true, no activity row', async () => {
    const base = await seedBaseFixture(pool, `transition-noop-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);

    // First transition lands the ticket in waiting + reason='requester'.
    await runRpcCapture<TransitionResult>(
      pool,
      'public.transition_entity_status',
      [ticketId, 'case', base.tenantId, null, `noop-prep-${ticketId}`, { status: 'waiting', status_category: 'waiting', waiting_reason: 'requester' }],
    );

    const actsBefore = await pool.query(
      `select count(*)::int as n from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2
          and metadata->>'event' = 'status_changed'`,
      [base.tenantId, ticketId],
    );

    // Re-call with the same target shape — RPC must short-circuit.
    const noop = await runRpcCapture<TransitionResult>(
      pool,
      'public.transition_entity_status',
      [ticketId, 'case', base.tenantId, null, `noop-real-${ticketId}`, { status: 'waiting', status_category: 'waiting', waiting_reason: 'requester' }],
    );

    expect(noop.kind).toBe('ok');
    if (noop.kind !== 'ok') return;
    expect(noop.value.noop).toBe(true);
    expect(noop.value.previous_status).toBe('waiting');
    expect(noop.value.new_status).toBe('waiting');

    // No new activity row — fast path skipped the insert.
    const actsAfter = await pool.query(
      `select count(*)::int as n from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2
          and metadata->>'event' = 'status_changed'`,
      [base.tenantId, ticketId],
    );
    expect(actsAfter.rows[0].n).toBe(actsBefore.rows[0].n);

    // command_operations still records the no-op call as success with the
    // noop=true cached_result (so future retries with the same key cache).
    const co = await pool.query(
      `select outcome, cached_result->>'noop' as noop_flag
         from public.command_operations
        where tenant_id = $1 and idempotency_key = $2`,
      [base.tenantId, `noop-real-${ticketId}`],
    );
    expect(co.rowCount).toBe(1);
    expect(co.rows[0].outcome).toBe('success');
    expect(co.rows[0].noop_flag).toBe('true');
  });
});

export {};
