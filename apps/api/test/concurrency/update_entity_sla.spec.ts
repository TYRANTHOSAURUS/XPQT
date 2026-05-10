/**
 * B.2.A.7 concurrency probe — update_entity_sla.
 *
 * Spec ref: docs/follow-ups/b2-survey-and-design.md §3.3 (lines 2040-2160).
 * Migration: supabase/migrations/00328_update_entity_sla_rpc.sql.
 * Harness pattern mirrors set_entity_assignment.spec.ts (00326 / 00327).
 *
 * Seven scenarios, all against the live local Supabase stack:
 *   1. Parallel idempotent — two clients fire same key + same payload in
 *      parallel. Advisory lock serialises (B blocks while A holds);
 *      after A commits, B returns the cached_result. Exactly one set of
 *      sla_timers rows inserted (no double-inserts because the cached
 *      path on B short-circuits before the INSERT).
 *   2. Payload mismatch — same key + different payload raises
 *      'command_operations.payload_mismatch'.
 *   3. Cross-tenant sla_id — payload references sla_policy from another
 *      tenant; raises
 *      'validate_entity_in_tenant.sla_policy_not_in_tenant'.
 *   4. SLA swap — pre-existing active timers stopped (stopped_at set,
 *      stopped_reason='sla_changed'); new timers inserted with the
 *      payload's due_at; entity row's sla_id updated; due_at columns
 *      reflect the new timers' due_at.
 *   5. Clear sla — payload {sla_id:null}; existing timers stopped;
 *      entity row sla_id cleared; due_at columns cleared; no new timers.
 *   6. No-op — same sla_id as current with no timers payload → returns
 *      noop:true; no writes to sla_timers / ticket_activities /
 *      domain_events.
 *   7. work_order path — same as scenario 4 but on a work_orders row.
 */

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  callRpc,
  flushAllFixtures,
  lockKey,
  pgLocksFor,
  registerCleanup,
  runRpcCapture,
  seedBaseFixture,
  waitForBlocker,
  withClient,
} from './helpers';
import { endPool, getPool } from './pool';

interface SeededTicket {
  ticketId: string;
}

interface SeededWorkOrder {
  ticketId: string; // parent
  workOrderId: string;
}

interface SeededSla {
  slaId: string;
  responseMinutes: number;
  resolutionMinutes: number;
}

interface SlaResult {
  entity_id: string;
  entity_kind: string;
  previous_sla_id: string | null;
  new_sla_id: string | null;
  timers_inserted: number;
  noop: boolean;
}

/**
 * Insert a minimal `tickets` row in `new` status. Cleanup wipes
 * sla_timers + ticket_activities + domain_events + command_operations
 * + tickets for the tenant (the RPC also writes to these and the base
 * fixture's cleanup doesn't include sla_timers).
 */
async function seedCase(pool: Pool, base: { tenantId: string; personId: string }): Promise<SeededTicket> {
  const ticketId = randomUUID();

  await withClient(pool, async (c) => {
    await c.query('begin');
    try {
      await c.query(
        `insert into public.tickets
           (id, tenant_id, title, status, status_category,
            requester_person_id, source_channel)
         values ($1, $2, 'Concurrency probe sla case', 'new', 'new', $3, 'system')`,
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
        await c.query('delete from public.ticket_activities where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.domain_events where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.sla_policies where tenant_id = $1', [base.tenantId]);
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

async function seedWorkOrder(
  pool: Pool,
  base: { tenantId: string; personId: string },
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
         values ($1, $2, 'Concurrency probe parent case', 'new', 'new', $3, 'system')`,
        [ticketId, base.tenantId, base.personId],
      );
      await c.query(
        `insert into public.work_orders
           (id, tenant_id, parent_kind, parent_ticket_id,
            title, status, status_category, source_channel)
         values ($1, $2, 'case', $3,
                 'Concurrency probe child WO', 'new', 'new', 'system')`,
        [workOrderId, base.tenantId, ticketId],
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
        await c.query('delete from public.ticket_activities where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.domain_events where tenant_id = $1', [base.tenantId]);
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
 * Insert a minimal sla_policies row (no business_hours_calendar — the RPC
 * doesn't read the policy beyond validate_entity_in_tenant). Tied to the
 * tenant, with response/resolution minutes the test can use to compute
 * payload due_at values.
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
    [slaId, tenantId, opts.name ?? 'Concurrency SLA', responseMinutes, resolutionMinutes],
  );
  return { slaId, responseMinutes, resolutionMinutes };
}

/**
 * Build a payload's `timers` array using TS-computed due_at values — the
 * RPC does NOT do business-hours math (per spec §3.3 line 2096-2097, that
 * lives in the TS plan-build phase). Returned `due_at`s are simple wall-
 * clock now()+minutes; the harness only verifies they round-trip into the
 * sla_timers row + the entity row's denorm columns.
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

describe('update_entity_sla — combined RPC', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = getPool();
  });

  afterAll(async () => {
    await flushAllFixtures(pool);
    await endPool();
  });

  it('scenario 1: parallel idempotent — advisory lock serializes; B returns cached_result; one set of timers inserted', async () => {
    const base = await seedBaseFixture(pool, `sla-parallel-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const sla = await seedSlaPolicy(pool, base.tenantId);

    const idem = `sla-parallel-${ticketId}`;
    const payload = {
      sla_id: sla.slaId,
      timers: buildTimersPayload(sla),
    };

    const probeKey = await withClient(pool, (c) => lockKey(c, `${base.tenantId}:${idem}`));

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    let aResult: SlaResult | undefined;
    let bResult: SlaResult | undefined;
    try {
      await clientA.query('begin');

      const before = await pgLocksFor(pool, probeKey);
      expect(before.filter((l) => l.granted).length).toBe(0);

      // Client A: enter the RPC, write rows, but DON'T commit yet.
      aResult = await callRpc<SlaResult>(
        clientA,
        'public.update_entity_sla',
        [ticketId, 'case', base.tenantId, null, idem, payload],
      );
      expect(aResult.noop).toBe(false);
      expect(aResult.new_sla_id).toBe(sla.slaId);
      expect(aResult.previous_sla_id).toBeNull();
      expect(aResult.timers_inserted).toBe(2);

      const duringA = await pgLocksFor(pool, probeKey);
      expect(duringA.filter((l) => l.granted).length).toBe(1);

      await clientB.query('begin');
      const bPromise = callRpc<SlaResult>(
        clientB,
        'public.update_entity_sla',
        [ticketId, 'case', base.tenantId, null, idem, payload],
      );

      await waitForBlocker(pool, probeKey, { timeoutMs: 5_000 });
      const duringContention = await pgLocksFor(pool, probeKey);
      expect(duringContention.some((l) => !l.granted)).toBe(true);
      expect(duringContention.filter((l) => l.granted).length).toBe(1);

      await clientA.query('commit');

      bResult = await bPromise;
      await clientB.query('commit');

      // B took the cached path — same result struct.
      expect(bResult).toEqual(aResult);
    } finally {
      try {
        await clientA.query('rollback');
      } catch {
        /* tx already finished */
      }
      try {
        await clientB.query('rollback');
      } catch {
        /* tx already finished */
      }
      clientA.release();
      clientB.release();
    }

    // Exactly TWO active sla_timers rows (one response, one resolution).
    // The cached path on client B short-circuits before re-insertion, so
    // no double-insert despite no unique-index on the table.
    const timers = await pool.query(
      `select timer_type, due_at, recompute_pending, paused
         from public.sla_timers
        where tenant_id = $1 and ticket_id = $2
          and stopped_at is null and completed_at is null
        order by timer_type`,
      [base.tenantId, ticketId],
    );
    expect(timers.rowCount).toBe(2);
    expect(timers.rows.map((r) => r.timer_type)).toEqual(['resolution', 'response']);
    // Fresh inserts must have recompute_pending=false (spec §3.3 line 2154-2159).
    for (const r of timers.rows) {
      expect(r.recompute_pending).toBe(false);
      expect(r.paused).toBe(false);
    }

    // Exactly one ticket_activities row — B did not re-insert.
    const acts = await pool.query(
      `select id from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2
          and metadata->>'event' = 'sla_changed'`,
      [base.tenantId, ticketId],
    );
    expect(acts.rowCount).toBe(1);

    // Exactly one domain_events row.
    const evs = await pool.query(
      `select id from public.domain_events
        where tenant_id = $1 and entity_id = $2 and event_type = 'ticket_sla_changed'`,
      [base.tenantId, ticketId],
    );
    expect(evs.rowCount).toBe(1);

    // command_operations marked success once with cached_result.
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
    const base = await seedBaseFixture(pool, `sla-mismatch-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const slaA = await seedSlaPolicy(pool, base.tenantId, { name: 'sla-A' });
    const slaB = await seedSlaPolicy(pool, base.tenantId, { name: 'sla-B' });

    const idem = `sla-mismatch-${ticketId}`;

    const first = await runRpcCapture<SlaResult>(
      pool,
      'public.update_entity_sla',
      [ticketId, 'case', base.tenantId, null, idem, { sla_id: slaA.slaId, timers: buildTimersPayload(slaA) }],
    );
    expect(first.kind).toBe('ok');

    const second = await runRpcCapture<SlaResult>(
      pool,
      'public.update_entity_sla',
      [ticketId, 'case', base.tenantId, null, idem, { sla_id: slaB.slaId, timers: buildTimersPayload(slaB) }],
    );
    expect(second.kind).toBe('error');
    if (second.kind !== 'error') return;
    expect(second.error.message).toMatch(/command_operations\.payload_mismatch/);
  });

  it('scenario 3: cross-tenant sla_id — payload references foreign tenant policy raises validate_entity_in_tenant.sla_policy_not_in_tenant', async () => {
    const tenantA = await seedBaseFixture(pool, `sla-xtenant-a-${Date.now()}`);
    const tenantB = await seedBaseFixture(pool, `sla-xtenant-b-${Date.now()}`);

    const { ticketId } = await seedCase(pool, tenantA);
    // Foreign SLA — owned by tenantB, must NOT be usable from tenantA.
    const foreign = await seedSlaPolicy(pool, tenantB.tenantId);

    const idem = `sla-xtenant-${ticketId}`;
    const result = await runRpcCapture<SlaResult>(
      pool,
      'public.update_entity_sla',
      [
        ticketId,
        'case',
        tenantA.tenantId,
        null,
        idem,
        { sla_id: foreign.slaId, timers: buildTimersPayload(foreign) },
      ],
    );

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toMatch(/validate_entity_in_tenant\.sla_policy_not_in_tenant/);

    // Entity row untouched — sla_id still null.
    const t = await pool.query(
      'select sla_id, sla_response_due_at, sla_resolution_due_at from public.tickets where id = $1',
      [ticketId],
    );
    expect(t.rows[0].sla_id).toBeNull();
    expect(t.rows[0].sla_response_due_at).toBeNull();
    expect(t.rows[0].sla_resolution_due_at).toBeNull();

    // No sla_timers / activity / domain_events written.
    const timers = await pool.query(
      'select id from public.sla_timers where tenant_id = $1 and ticket_id = $2',
      [tenantA.tenantId, ticketId],
    );
    expect(timers.rowCount).toBe(0);

    const acts = await pool.query(
      'select id from public.ticket_activities where tenant_id = $1 and ticket_id = $2',
      [tenantA.tenantId, ticketId],
    );
    expect(acts.rowCount).toBe(0);

    const evs = await pool.query(
      'select id from public.domain_events where tenant_id = $1 and entity_id = $2',
      [tenantA.tenantId, ticketId],
    );
    expect(evs.rowCount).toBe(0);

    // command_operations row rolled back with the failed tx (no row).
    const co = await pool.query(
      'select outcome from public.command_operations where tenant_id = $1 and idempotency_key = $2',
      [tenantA.tenantId, idem],
    );
    expect(co.rowCount).toBe(0);
  });

  it('scenario 4: sla swap — pre-existing active timers stopped, new timers inserted, entity due_at columns updated', async () => {
    const base = await seedBaseFixture(pool, `sla-swap-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const slaOld = await seedSlaPolicy(pool, base.tenantId, {
      responseMinutes: 30,
      resolutionMinutes: 120,
      name: 'old',
    });
    const slaNew = await seedSlaPolicy(pool, base.tenantId, {
      responseMinutes: 90,
      resolutionMinutes: 360,
      name: 'new',
    });

    // Step 1: assign initial SLA.
    const first = await runRpcCapture<SlaResult>(
      pool,
      'public.update_entity_sla',
      [
        ticketId,
        'case',
        base.tenantId,
        null,
        `sla-swap-${ticketId}-1`,
        { sla_id: slaOld.slaId, timers: buildTimersPayload(slaOld) },
      ],
    );
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(first.value.timers_inserted).toBe(2);

    // Snapshot the timer ids that should be stopped after step 2.
    const oldTimers = await pool.query(
      `select id, timer_type, sla_policy_id from public.sla_timers
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(oldTimers.rowCount).toBe(2);

    // Step 2: swap to new SLA.
    const newTimersPayload = buildTimersPayload(slaNew);
    const second = await runRpcCapture<SlaResult>(
      pool,
      'public.update_entity_sla',
      [
        ticketId,
        'case',
        base.tenantId,
        null,
        `sla-swap-${ticketId}-2`,
        { sla_id: slaNew.slaId, timers: newTimersPayload },
      ],
    );
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.value.noop).toBe(false);
    expect(second.value.previous_sla_id).toBe(slaOld.slaId);
    expect(second.value.new_sla_id).toBe(slaNew.slaId);
    expect(second.value.timers_inserted).toBe(2);

    // Old timers all marked stopped with reason='sla_changed'.
    const stoppedOld = await pool.query(
      `select id, stopped_at, stopped_reason from public.sla_timers
        where id = any($1::uuid[])`,
      [oldTimers.rows.map((r) => r.id)],
    );
    expect(stoppedOld.rowCount).toBe(2);
    for (const row of stoppedOld.rows) {
      expect(row.stopped_at).not.toBeNull();
      expect(row.stopped_reason).toBe('sla_changed');
    }

    // New timers exist (active), reference slaNew, due_at matches payload.
    const newTimers = await pool.query(
      `select timer_type, sla_policy_id, due_at, recompute_pending, paused
         from public.sla_timers
        where tenant_id = $1 and ticket_id = $2
          and stopped_at is null and completed_at is null
        order by timer_type`,
      [base.tenantId, ticketId],
    );
    expect(newTimers.rowCount).toBe(2);
    expect(newTimers.rows.every((r) => r.sla_policy_id === slaNew.slaId)).toBe(true);
    expect(newTimers.rows.every((r) => r.recompute_pending === false)).toBe(true);
    expect(newTimers.rows.every((r) => r.paused === false)).toBe(true);

    // Entity row reflects new sla_id + due_at columns sync to new timers.
    const responseDueExpected = newTimersPayload.find((t) => t.timer_type === 'response')!.due_at;
    const resolutionDueExpected = newTimersPayload.find((t) => t.timer_type === 'resolution')!.due_at;
    const t = await pool.query(
      'select sla_id, sla_response_due_at, sla_resolution_due_at from public.tickets where id = $1',
      [ticketId],
    );
    expect(t.rows[0].sla_id).toBe(slaNew.slaId);
    expect(new Date(t.rows[0].sla_response_due_at).toISOString()).toBe(responseDueExpected);
    expect(new Date(t.rows[0].sla_resolution_due_at).toISOString()).toBe(resolutionDueExpected);

    // Two ticket_activities sla_changed rows (step 1 + step 2).
    const acts = await pool.query(
      `select metadata->>'event' as event,
              metadata->>'previous_sla_id' as prev,
              metadata->>'new_sla_id' as next
         from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2
        order by created_at`,
      [base.tenantId, ticketId],
    );
    expect(acts.rowCount).toBe(2);
    expect(acts.rows[0].event).toBe('sla_changed');
    expect(acts.rows[0].prev).toBeNull();
    expect(acts.rows[0].next).toBe(slaOld.slaId);
    expect(acts.rows[1].event).toBe('sla_changed');
    expect(acts.rows[1].prev).toBe(slaOld.slaId);
    expect(acts.rows[1].next).toBe(slaNew.slaId);

    // Two domain_events emitted.
    const evs = await pool.query(
      `select payload->>'previous_sla_id' as prev, payload->>'new_sla_id' as next
         from public.domain_events
        where tenant_id = $1 and entity_id = $2 and event_type = 'ticket_sla_changed'
        order by created_at`,
      [base.tenantId, ticketId],
    );
    expect(evs.rowCount).toBe(2);
    expect(evs.rows[1].prev).toBe(slaOld.slaId);
    expect(evs.rows[1].next).toBe(slaNew.slaId);
  });

  it('scenario 5: clear sla — payload sla_id:null stops existing timers, clears entity row, no new timers inserted', async () => {
    const base = await seedBaseFixture(pool, `sla-clear-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const sla = await seedSlaPolicy(pool, base.tenantId);

    // Step 1: assign SLA.
    const first = await runRpcCapture<SlaResult>(
      pool,
      'public.update_entity_sla',
      [
        ticketId,
        'case',
        base.tenantId,
        null,
        `sla-clear-${ticketId}-1`,
        { sla_id: sla.slaId, timers: buildTimersPayload(sla) },
      ],
    );
    expect(first.kind).toBe('ok');

    // Step 2: clear it.
    const second = await runRpcCapture<SlaResult>(
      pool,
      'public.update_entity_sla',
      [ticketId, 'case', base.tenantId, null, `sla-clear-${ticketId}-2`, { sla_id: null }],
    );
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.value.noop).toBe(false);
    expect(second.value.previous_sla_id).toBe(sla.slaId);
    expect(second.value.new_sla_id).toBeNull();
    expect(second.value.timers_inserted).toBe(0);

    // Existing timers all stopped with reason='sla_changed'. No active rows.
    const active = await pool.query(
      `select id from public.sla_timers
        where tenant_id = $1 and ticket_id = $2
          and stopped_at is null and completed_at is null`,
      [base.tenantId, ticketId],
    );
    expect(active.rowCount).toBe(0);

    const stopped = await pool.query(
      `select stopped_reason from public.sla_timers
        where tenant_id = $1 and ticket_id = $2
          and stopped_at is not null`,
      [base.tenantId, ticketId],
    );
    expect(stopped.rowCount).toBe(2);
    expect(stopped.rows.every((r) => r.stopped_reason === 'sla_changed')).toBe(true);

    // Entity row reflects the clear.
    const t = await pool.query(
      'select sla_id, sla_response_due_at, sla_resolution_due_at from public.tickets where id = $1',
      [ticketId],
    );
    expect(t.rows[0].sla_id).toBeNull();
    expect(t.rows[0].sla_response_due_at).toBeNull();
    expect(t.rows[0].sla_resolution_due_at).toBeNull();
  });

  it('scenario 6: no-op — same sla_id as current, no timers payload → noop:true, no writes', async () => {
    const base = await seedBaseFixture(pool, `sla-noop-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const sla = await seedSlaPolicy(pool, base.tenantId);

    // Step 1: set initial SLA.
    const first = await runRpcCapture<SlaResult>(
      pool,
      'public.update_entity_sla',
      [
        ticketId,
        'case',
        base.tenantId,
        null,
        `sla-noop-${ticketId}-1`,
        { sla_id: sla.slaId, timers: buildTimersPayload(sla) },
      ],
    );
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(first.value.noop).toBe(false);

    // Snapshot row counts after step 1.
    const before = {
      timers: (await pool.query(
        'select count(*)::int as n from public.sla_timers where tenant_id = $1 and ticket_id = $2',
        [base.tenantId, ticketId],
      )).rows[0].n as number,
      acts: (await pool.query(
        'select count(*)::int as n from public.ticket_activities where tenant_id = $1 and ticket_id = $2',
        [base.tenantId, ticketId],
      )).rows[0].n as number,
      evs: (await pool.query(
        'select count(*)::int as n from public.domain_events where tenant_id = $1 and entity_id = $2',
        [base.tenantId, ticketId],
      )).rows[0].n as number,
    };

    // Step 2: same sla_id, no timers payload — must noop.
    const second = await runRpcCapture<SlaResult>(
      pool,
      'public.update_entity_sla',
      [ticketId, 'case', base.tenantId, null, `sla-noop-${ticketId}-2`, { sla_id: sla.slaId }],
    );
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.value.noop).toBe(true);
    expect(second.value.previous_sla_id).toBe(sla.slaId);
    expect(second.value.new_sla_id).toBe(sla.slaId);
    expect(second.value.timers_inserted).toBe(0);

    // Row counts unchanged.
    const after = {
      timers: (await pool.query(
        'select count(*)::int as n from public.sla_timers where tenant_id = $1 and ticket_id = $2',
        [base.tenantId, ticketId],
      )).rows[0].n as number,
      acts: (await pool.query(
        'select count(*)::int as n from public.ticket_activities where tenant_id = $1 and ticket_id = $2',
        [base.tenantId, ticketId],
      )).rows[0].n as number,
      evs: (await pool.query(
        'select count(*)::int as n from public.domain_events where tenant_id = $1 and entity_id = $2',
        [base.tenantId, ticketId],
      )).rows[0].n as number,
    };
    expect(after).toEqual(before);

    // command_operations row marked success with noop=true cached_result.
    const co = await pool.query(
      `select outcome, cached_result->>'noop' as noop
         from public.command_operations
        where tenant_id = $1 and idempotency_key = $2`,
      [base.tenantId, `sla-noop-${ticketId}-2`],
    );
    expect(co.rowCount).toBe(1);
    expect(co.rows[0].outcome).toBe('success');
    expect(co.rows[0].noop).toBe('true');
  });

  it('scenario 7: work_order path — UPDATE lands on work_orders, sla_at_risk/paused reset, parent ticket untouched', async () => {
    const base = await seedBaseFixture(pool, `sla-wo-${Date.now()}`);
    const { ticketId, workOrderId } = await seedWorkOrder(pool, base);
    const sla = await seedSlaPolicy(pool, base.tenantId);

    const timersPayload = buildTimersPayload(sla);
    const result = await runRpcCapture<SlaResult>(
      pool,
      'public.update_entity_sla',
      [
        workOrderId,
        'work_order',
        base.tenantId,
        null,
        `sla-wo-${workOrderId}`,
        { sla_id: sla.slaId, timers: timersPayload },
      ],
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.noop).toBe(false);
    expect(result.value.entity_kind).toBe('work_order');
    expect(result.value.new_sla_id).toBe(sla.slaId);
    expect(result.value.timers_inserted).toBe(2);

    // work_orders row reflects the new SLA + cleared at_risk/paused/breach
    // columns (the work_order branch resets the wider set per spec
    // alignment with sla.service.ts:309-318).
    const responseDueExpected = timersPayload.find((t) => t.timer_type === 'response')!.due_at;
    const resolutionDueExpected = timersPayload.find((t) => t.timer_type === 'resolution')!.due_at;
    const wo = await pool.query(
      `select sla_id, sla_response_due_at, sla_resolution_due_at,
              sla_at_risk, sla_paused, sla_paused_at,
              sla_response_breached_at, sla_resolution_breached_at
         from public.work_orders where id = $1`,
      [workOrderId],
    );
    expect(wo.rows[0].sla_id).toBe(sla.slaId);
    expect(new Date(wo.rows[0].sla_response_due_at).toISOString()).toBe(responseDueExpected);
    expect(new Date(wo.rows[0].sla_resolution_due_at).toISOString()).toBe(resolutionDueExpected);
    expect(wo.rows[0].sla_at_risk).toBe(false);
    expect(wo.rows[0].sla_paused).toBe(false);
    expect(wo.rows[0].sla_paused_at).toBeNull();
    expect(wo.rows[0].sla_response_breached_at).toBeNull();
    expect(wo.rows[0].sla_resolution_breached_at).toBeNull();

    // sla_timers polymorphic columns: entity_kind='work_order',
    // work_order_id=workOrderId, case_id NULL, ticket_id=workOrderId
    // (ticket_id is the legacy non-null discriminator on sla_timers,
    // mirrors the convention in the RPC).
    const timers = await pool.query(
      `select entity_kind, case_id, work_order_id, ticket_id
         from public.sla_timers
        where tenant_id = $1 and sla_policy_id = $2
          and stopped_at is null and completed_at is null`,
      [base.tenantId, sla.slaId],
    );
    expect(timers.rowCount).toBe(2);
    for (const row of timers.rows) {
      expect(row.entity_kind).toBe('work_order');
      expect(row.case_id).toBeNull();
      expect(row.work_order_id).toBe(workOrderId);
      expect(row.ticket_id).toBe(workOrderId);
    }

    // Parent ticket untouched.
    const t = await pool.query(
      'select sla_id, sla_response_due_at, sla_resolution_due_at from public.tickets where id = $1',
      [ticketId],
    );
    expect(t.rows[0].sla_id).toBeNull();
    expect(t.rows[0].sla_response_due_at).toBeNull();
    expect(t.rows[0].sla_resolution_due_at).toBeNull();

    // ticket_activities row written with ticket_id=workOrderId (mirrors
    // the 00326/00327 work_order convention — RPC writes ticket_activities
    // .ticket_id = p_entity_id regardless of kind).
    const acts = await pool.query(
      `select metadata->>'event' as event, visibility
         from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, workOrderId],
    );
    expect(acts.rowCount).toBe(1);
    expect(acts.rows[0].event).toBe('sla_changed');
    expect(acts.rows[0].visibility).toBe('system');

    // domain_events row uses entity_type='ticket' uniformly.
    const evs = await pool.query(
      `select event_type, entity_type from public.domain_events
        where tenant_id = $1 and entity_id = $2 and event_type = 'ticket_sla_changed'`,
      [base.tenantId, workOrderId],
    );
    expect(evs.rowCount).toBe(1);
    expect(evs.rows[0].entity_type).toBe('ticket');
  });
});

export {};
