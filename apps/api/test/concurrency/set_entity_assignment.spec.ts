/**
 * B.2.A.6 concurrency probe — set_entity_assignment.
 *
 * Spec ref: docs/follow-ups/b2-survey-and-design.md §3.2 (lines 1986-2037).
 * Migration: supabase/migrations/00326_set_entity_assignment_rpc.sql,
 * superseded by 00327_set_entity_assignment_v2.sql (domain_events INSERT
 * + metadata shape alignment).
 * Harness pattern mirrors transition_entity_status.spec.ts (00323 / 00325).
 *
 * Ten scenarios, all against the live local Supabase stack:
 *   1. Advisory-lock serialisation — two clients fire the RPC in parallel
 *      with the same idempotency_key + same payload. Client B's pg_locks
 *      row shows granted=false until A commits; B then returns the cached
 *      result and exactly one ticket_activities row is written.
 *   2. Payload mismatch — same key + different payload raises
 *      'command_operations.payload_mismatch'.
 *   3. Cross-tenant assignee — payload references a user from a different
 *      tenant; the validate_assignees_in_tenant helper raises
 *      'validate_assignees_in_tenant.assigned_user_id_not_in_tenant'.
 *      No row UPDATE.
 *   4. Silent assignment (no reason) — assigned_user_id changes;
 *      ticket_activities row has metadata.event='assignment_changed';
 *      NO routing_decisions row written. metadata.previous + .next contain
 *      ONLY the changed assigned_user_id field (00327 C3 alignment).
 *   5. Reassign with reason — payload includes `reason`;
 *      ticket_activities row has metadata.event='reassigned';
 *      routing_decisions row exists with chosen_by='manual_reassign'.
 *      metadata.previous is short-key {team,user,vendor}; metadata.next is
 *      {kind,id} for the single non-null target axis (00327 C3).
 *   6. rerun_resolver rejected — payload has `rerun_resolver=true`;
 *      raises 'set_entity_assignment.resolver_rerun_not_supported_at_rpc'.
 *   7. work_order path (I5) — assign a user to a work_orders row; the
 *      row UPDATE + activity write hit work_orders, not tickets. Sister
 *      tickets row (if any) is untouched.
 *   8. Clear all assignees (I5) — payload sets all three assigned_*_id to
 *      null on a previously-assigned row. status_category does NOT demote
 *      back to 'new' (only elevation new -> assigned is wired).
 *   9. Reason present + assignment unchanged (I5) — payload carries
 *      reason but the assignees match current. The no-op fast path does
 *      NOT apply (reason itself is the audit signal); routing_decisions
 *      row + ticket_activities row are STILL written.
 *  10. Two writers, different idempotency keys, same row (I5) — they do
 *      NOT serialize on the advisory lock (different keys = different
 *      lock partitions). They DO serialize on SELECT FOR UPDATE; second
 *      waits via pg_locks (relation lock, not advisory) until first
 *      commits.
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
  ticketId: string;     // parent ticket
  workOrderId: string;
}

interface SeededUser {
  userId: string;
  authUid: string;
  personId: string;
}

/**
 * Insert a minimal `tickets` row in `new` status for the harness, plus
 * register a cleanup that wipes routing_decisions + ticket_activities +
 * tickets + command_operations + outbox.events rows for the tenant.
 *
 * Pattern mirrors transition_entity_status.spec.ts:53-110 with two
 * additions: routing_decisions cleanup (the §3.2 RPC writes audit rows
 * on the reassign-with-reason branch) and outbox.events cleanup (the
 * RPC emits ticket_assigned / work_order_assigned events).
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
         values ($1, $2, 'Concurrency probe case', 'new', 'new', $3, 'system')`,
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
        await c.query('delete from public.routing_decisions where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.ticket_activities where tenant_id = $1', [base.tenantId]);
        await c.query('delete from outbox.events where tenant_id = $1', [base.tenantId]);
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
 * Insert a public.users row scoped to a given tenant. The §3.2 RPC's
 * tenant-validation step calls validate_assignees_in_tenant(...) which
 * checks that every non-null assignee's tenant_id matches p_tenant_id.
 * The cross-tenant scenario relies on having a real user in a *different*
 * tenant so the assertion fires on tenant mismatch (not on row absence).
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
         values ($1, $2, 'employee', 'Assignee', 'Concurrency', $3)`,
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
 * Seed a parent ticket + a child work_orders row in `new` status. The
 * §3.2 RPC supports both entity_kind='case' (tickets) and 'work_order'
 * (work_orders); scenario 7 uses this to verify the work_order path
 * lands UPDATEs on the right table. Cleanup mirrors seedCase + adds
 * work_orders.
 */
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
        await c.query('delete from public.routing_decisions where tenant_id = $1', [base.tenantId]);
        await c.query('delete from public.ticket_activities where tenant_id = $1', [base.tenantId]);
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

interface AssignmentResult {
  entity_id: string;
  entity_kind: string;
  previous_assigned_team_id: string | null;
  previous_assigned_user_id: string | null;
  previous_assigned_vendor_id: string | null;
  new_assigned_team_id: string | null;
  new_assigned_user_id: string | null;
  new_assigned_vendor_id: string | null;
  previous_status_category: string;
  new_status_category: string;
  reason: string | null;
  noop: boolean;
}

describe('set_entity_assignment — combined RPC', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = getPool();
  });

  afterAll(async () => {
    await flushAllFixtures(pool);
    await endPool();
  });

  it('scenario 1: advisory lock serializes parallel calls with same key — one activity row, B blocks until A commits', async () => {
    const base = await seedBaseFixture(pool, `assign-parallel-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const { userId } = await seedUser(pool, base.tenantId);

    const idem = `assign-parallel-${ticketId}`;
    const payload = {
      assigned_user_id: userId,
    };

    // Compute the lock key the RPC will derive (00326 — same hash as 00323).
    const probeKey = await withClient(pool, (c) => lockKey(c, `${base.tenantId}:${idem}`));

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    let aResult: AssignmentResult | undefined;
    let bResult: AssignmentResult | undefined;
    try {
      await clientA.query('begin');

      // Sanity: nobody is holding the lock yet.
      const before = await pgLocksFor(pool, probeKey);
      expect(before.filter((l) => l.granted).length).toBe(0);

      // ── Client A: enter the RPC, acquire the lock, write the row,
      //    return — but DON'T commit yet so B blocks.
      aResult = await callRpc<AssignmentResult>(
        clientA,
        'public.set_entity_assignment',
        [ticketId, 'case', base.tenantId, null, idem, payload],
      );
      expect(aResult.noop).toBe(false);
      expect(aResult.new_assigned_user_id).toBe(userId);
      expect(aResult.previous_assigned_user_id).toBeNull();
      expect(aResult.previous_status_category).toBe('new');
      expect(aResult.new_status_category).toBe('assigned');

      const duringA = await pgLocksFor(pool, probeKey);
      expect(duringA.filter((l) => l.granted).length).toBe(1);

      // ── Client B: BEGIN + start the RPC in the BACKGROUND. It must
      //    block on the advisory lock until A commits.
      await clientB.query('begin');
      const bPromise = callRpc<AssignmentResult>(
        clientB,
        'public.set_entity_assignment',
        [ticketId, 'case', base.tenantId, null, idem, payload],
      );

      await waitForBlocker(pool, probeKey, { timeoutMs: 5_000 });
      const duringContention = await pgLocksFor(pool, probeKey);
      expect(duringContention.some((l) => !l.granted)).toBe(true);
      expect(duringContention.filter((l) => l.granted).length).toBe(1);

      // ── Commit A. B unblocks, returns the cached_result.
      await clientA.query('commit');

      bResult = await bPromise;
      await clientB.query('commit');

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

    // Exactly ONE assignment_changed activity row across both parallel
    // calls — B took the cached path (00326 §3.2 same gate) and did
    // not re-insert.
    const acts = await pool.query(
      `select id from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2
          and metadata->>'event' = 'assignment_changed'`,
      [base.tenantId, ticketId],
    );
    expect(acts.rowCount).toBe(1);

    // No routing_decisions row — silent assignment (no reason).
    const rd = await pool.query(
      'select id from public.routing_decisions where tenant_id = $1 and ticket_id = $2',
      [base.tenantId, ticketId],
    );
    expect(rd.rowCount).toBe(0);

    // command_operations row marked success once with cached_result.
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
    const base = await seedBaseFixture(pool, `assign-mismatch-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const { userId: userA } = await seedUser(pool, base.tenantId);
    const { userId: userB } = await seedUser(pool, base.tenantId);

    const idem = `assign-mismatch-${ticketId}`;

    const first = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [ticketId, 'case', base.tenantId, null, idem, { assigned_user_id: userA }],
    );
    expect(first.kind).toBe('ok');

    // Same idempotency_key but different payload (different user).
    const second = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [ticketId, 'case', base.tenantId, null, idem, { assigned_user_id: userB }],
    );
    expect(second.kind).toBe('error');
    if (second.kind !== 'error') return;
    expect(second.error.message).toMatch(/command_operations\.payload_mismatch/);
  });

  it('scenario 3: cross-tenant assignee — user from another tenant raises validate_assignees_in_tenant.assigned_user_id_not_in_tenant', async () => {
    const tenantA = await seedBaseFixture(pool, `assign-xtenant-a-${Date.now()}`);
    const tenantB = await seedBaseFixture(pool, `assign-xtenant-b-${Date.now()}`);

    const { ticketId } = await seedCase(pool, tenantA);
    // Foreign user — exists in tenantB, not tenantA.
    const foreign = await seedUser(pool, tenantB.tenantId);

    const idem = `assign-xtenant-${ticketId}`;
    const result = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [ticketId, 'case', tenantA.tenantId, null, idem, { assigned_user_id: foreign.userId }],
    );

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toMatch(/validate_assignees_in_tenant\.assigned_user_id_not_in_tenant/);

    // No row UPDATE — ticket still unassigned.
    const t = await pool.query(
      'select assigned_user_id, status_category from public.tickets where id = $1',
      [ticketId],
    );
    expect(t.rows[0].assigned_user_id).toBeNull();
    expect(t.rows[0].status_category).toBe('new');

    // command_operations row rolled back with the failed tx (no row).
    const co = await pool.query(
      'select outcome from public.command_operations where tenant_id = $1 and idempotency_key = $2',
      [tenantA.tenantId, idem],
    );
    expect(co.rowCount).toBe(0);
  });

  it('scenario 4: silent assignment (no reason) — one assignment_changed activity, no routing_decisions row, metadata shape narrow', async () => {
    const base = await seedBaseFixture(pool, `assign-silent-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const { userId } = await seedUser(pool, base.tenantId);

    const result = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [ticketId, 'case', base.tenantId, null, `assign-silent-${ticketId}`, { assigned_user_id: userId }],
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.noop).toBe(false);
    expect(result.value.reason).toBeNull();
    expect(result.value.new_assigned_user_id).toBe(userId);
    expect(result.value.new_status_category).toBe('assigned');

    // ticket_activities — exactly one assignment_changed row, metadata
    // shape narrow per 00327 C3 (only changed assigned_*_id keys).
    const acts = await pool.query(
      `select metadata->>'event' as event, visibility, content, metadata
         from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(acts.rowCount).toBe(1);
    expect(acts.rows[0].event).toBe('assignment_changed');
    expect(acts.rows[0].visibility).toBe('system');
    expect(acts.rows[0].content).toBeNull();
    // Only assigned_user_id changed; previous + next contain ONLY that key.
    expect(acts.rows[0].metadata.previous).toEqual({ assigned_user_id: null });
    expect(acts.rows[0].metadata.next).toEqual({ assigned_user_id: userId });

    // routing_decisions — none (silent path skips audit row).
    const rd = await pool.query(
      'select id from public.routing_decisions where tenant_id = $1 and ticket_id = $2',
      [base.tenantId, ticketId],
    );
    expect(rd.rowCount).toBe(0);

    // domain_events — one ticket_assigned event emitted (00327 C1+C2:
    // moved from outbox.events to public.domain_events per spec line 2024).
    const evs = await pool.query(
      `select event_type from public.domain_events
        where tenant_id = $1 and entity_id = $2 and event_type = 'ticket_assigned'`,
      [base.tenantId, ticketId],
    );
    expect(evs.rowCount).toBe(1);
  });

  it('scenario 5: reassign with reason — one reassigned activity, one routing_decisions row with chosen_by=manual_reassign', async () => {
    const base = await seedBaseFixture(pool, `assign-reason-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const { userId } = await seedUser(pool, base.tenantId);
    // Assign a person to act as the reassigner — payload.actor_person_id
    // is the spec-mandated attribution channel for the reassign-with-reason
    // path (set_entity_assignment_rpc.sql §11 routing_decisions audit row).
    const actorPerson = await seedUser(pool, base.tenantId);

    const result = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [
        ticketId,
        'case',
        base.tenantId,
        null,
        `assign-reason-${ticketId}`,
        {
          assigned_user_id: userId,
          reason: 'Workload rebalance',
          actor_person_id: actorPerson.personId,
        },
      ],
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.noop).toBe(false);
    expect(result.value.reason).toBe('Workload rebalance');

    // ticket_activities — exactly one reassigned row, visibility=internal.
    // metadata.previous is short-key shape; metadata.next is {kind,id} per
    // 00327 C3 alignment with ticket.service.ts:1431-1443.
    const acts = await pool.query(
      `select metadata->>'event' as event, visibility, content, author_person_id, metadata
         from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(acts.rowCount).toBe(1);
    expect(acts.rows[0].event).toBe('reassigned');
    expect(acts.rows[0].visibility).toBe('internal');
    expect(acts.rows[0].content).toBe('Workload rebalance');
    expect(acts.rows[0].author_person_id).toBe(actorPerson.personId);
    expect(acts.rows[0].metadata.previous).toEqual({ team: null, user: null, vendor: null });
    expect(acts.rows[0].metadata.next).toEqual({ kind: 'user', id: userId });

    // routing_decisions — exactly one row with chosen_by='manual_reassign',
    // strategy='manual', polymorphic columns set, chosen_user_id matches.
    const rd = await pool.query(
      `select chosen_by, strategy, entity_kind, case_id, work_order_id,
              chosen_team_id, chosen_user_id, chosen_vendor_id,
              context->>'reason' as reason
         from public.routing_decisions
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(rd.rowCount).toBe(1);
    expect(rd.rows[0].chosen_by).toBe('manual_reassign');
    expect(rd.rows[0].strategy).toBe('manual');
    expect(rd.rows[0].entity_kind).toBe('case');
    expect(rd.rows[0].case_id).toBe(ticketId);
    expect(rd.rows[0].work_order_id).toBeNull();
    expect(rd.rows[0].chosen_user_id).toBe(userId);
    expect(rd.rows[0].chosen_team_id).toBeNull();
    expect(rd.rows[0].chosen_vendor_id).toBeNull();
    expect(rd.rows[0].reason).toBe('Workload rebalance');
  });

  it('scenario 6: rerun_resolver rejected — payload with rerun_resolver=true raises set_entity_assignment.resolver_rerun_not_supported_at_rpc', async () => {
    const base = await seedBaseFixture(pool, `assign-rerun-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const { userId } = await seedUser(pool, base.tenantId);

    const idem = `assign-rerun-${ticketId}`;
    const result = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [
        ticketId,
        'case',
        base.tenantId,
        null,
        idem,
        { assigned_user_id: userId, rerun_resolver: true },
      ],
    );

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.error.message).toMatch(/set_entity_assignment\.resolver_rerun_not_supported_at_rpc/);

    // No row UPDATE.
    const t = await pool.query(
      'select assigned_user_id, status_category from public.tickets where id = $1',
      [ticketId],
    );
    expect(t.rows[0].assigned_user_id).toBeNull();
    expect(t.rows[0].status_category).toBe('new');

    // No command_operations row — the reject happens BEFORE the RPC
    // inserts the in_progress marker (set_entity_assignment_rpc.sql §1
    // is the first guard, before §2's advisory lock and §3's CO insert).
    const co = await pool.query(
      'select outcome from public.command_operations where tenant_id = $1 and idempotency_key = $2',
      [base.tenantId, idem],
    );
    expect(co.rowCount).toBe(0);
  });

  it('scenario 7: work_order path — UPDATE lands on work_orders, parent ticket untouched', async () => {
    const base = await seedBaseFixture(pool, `assign-wo-${Date.now()}`);
    const { ticketId, workOrderId } = await seedWorkOrder(pool, base);
    const { userId } = await seedUser(pool, base.tenantId);

    const result = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [
        workOrderId,
        'work_order',
        base.tenantId,
        null,
        `assign-wo-${workOrderId}`,
        { assigned_user_id: userId },
      ],
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.noop).toBe(false);
    expect(result.value.entity_kind).toBe('work_order');
    expect(result.value.new_assigned_user_id).toBe(userId);
    expect(result.value.new_status_category).toBe('assigned');

    // work_orders row UPDATEd.
    const wo = await pool.query(
      'select assigned_user_id, status_category from public.work_orders where id = $1',
      [workOrderId],
    );
    expect(wo.rows[0].assigned_user_id).toBe(userId);
    expect(wo.rows[0].status_category).toBe('assigned');

    // Parent tickets row: assignment columns must NOT mirror — the RPC
    // hit work_orders, not tickets. status_category may be lifted to
    // 'assigned' by the rollup_parent_status_from_work_orders trigger
    // (00220-era), which propagates child-WO status to parent. That is
    // legitimate cross-row state; what the test verifies is that the
    // assignment FK columns themselves did not move.
    const t = await pool.query(
      'select assigned_team_id, assigned_user_id, assigned_vendor_id from public.tickets where id = $1',
      [ticketId],
    );
    expect(t.rows[0].assigned_team_id).toBeNull();
    expect(t.rows[0].assigned_user_id).toBeNull();
    expect(t.rows[0].assigned_vendor_id).toBeNull();

    // ticket_activities row written with ticket_id=workOrderId (the
    // RPC writes ticket_activities.ticket_id = p_entity_id regardless
    // of kind — same convention as work-order.service.ts:1424).
    const acts = await pool.query(
      `select metadata->>'event' as event, visibility
         from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, workOrderId],
    );
    expect(acts.rowCount).toBe(1);
    expect(acts.rows[0].event).toBe('assignment_changed');

    // domain_events row uses entity_type='ticket' uniformly (work-order
    // service.ts:1923-1929 + spec line 2024) with entity_id=workOrderId.
    const evs = await pool.query(
      `select event_type, entity_type from public.domain_events
        where tenant_id = $1 and entity_id = $2 and event_type = 'ticket_assigned'`,
      [base.tenantId, workOrderId],
    );
    expect(evs.rowCount).toBe(1);
    expect(evs.rows[0].entity_type).toBe('ticket');
  });

  it('scenario 8: clear all assignees — status_category does NOT demote back to new', async () => {
    const base = await seedBaseFixture(pool, `assign-clear-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const { userId } = await seedUser(pool, base.tenantId);

    // Step 1: assign — drives status_category 'new' -> 'assigned'.
    const first = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [ticketId, 'case', base.tenantId, null, `assign-clear-${ticketId}-1`, { assigned_user_id: userId }],
    );
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(first.value.new_status_category).toBe('assigned');

    // Step 2: clear all three keys explicitly. status_category must NOT
    // demote (00326/00327 only elevates new -> assigned; clearing back
    // to no-assignee is a valid intermediate state, not a status
    // regression).
    const second = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [
        ticketId,
        'case',
        base.tenantId,
        null,
        `assign-clear-${ticketId}-2`,
        {
          assigned_team_id: null,
          assigned_user_id: null,
          assigned_vendor_id: null,
        },
      ],
    );
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.value.noop).toBe(false);
    expect(second.value.new_assigned_team_id).toBeNull();
    expect(second.value.new_assigned_user_id).toBeNull();
    expect(second.value.new_assigned_vendor_id).toBeNull();
    // No demotion: previous_status_category was 'assigned' (post step 1),
    // new_status_category stays 'assigned'.
    expect(second.value.previous_status_category).toBe('assigned');
    expect(second.value.new_status_category).toBe('assigned');

    // Confirm row state on disk.
    const t = await pool.query(
      'select assigned_team_id, assigned_user_id, assigned_vendor_id, status_category from public.tickets where id = $1',
      [ticketId],
    );
    expect(t.rows[0].assigned_team_id).toBeNull();
    expect(t.rows[0].assigned_user_id).toBeNull();
    expect(t.rows[0].assigned_vendor_id).toBeNull();
    expect(t.rows[0].status_category).toBe('assigned');

    // Two activity rows total — one for the assign, one for the clear.
    const acts = await pool.query(
      `select metadata->>'event' as event
         from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2
        order by created_at`,
      [base.tenantId, ticketId],
    );
    expect(acts.rowCount).toBe(2);
    expect(acts.rows[0].event).toBe('assignment_changed');
    expect(acts.rows[1].event).toBe('assignment_changed');
  });

  it('scenario 9: reason present + assignment unchanged — no-op fast path skipped, audit + activity STILL written', async () => {
    const base = await seedBaseFixture(pool, `assign-reason-noop-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const { userId } = await seedUser(pool, base.tenantId);
    const actor = await seedUser(pool, base.tenantId);

    // Step 1: assign without reason — silent path.
    const first = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [ticketId, 'case', base.tenantId, null, `assign-reason-noop-${ticketId}-1`, { assigned_user_id: userId }],
    );
    expect(first.kind).toBe('ok');

    // Step 2: same assignee + reason. The RPC must NOT take the no-op
    // path (00327 §9: noop fast path requires reason IS NULL). Behavior
    // matches the manual-reassign UX where an admin records a reason
    // for keeping the same assignee.
    const second = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [
        ticketId,
        'case',
        base.tenantId,
        null,
        `assign-reason-noop-${ticketId}-2`,
        {
          assigned_user_id: userId,
          reason: 'Confirming assignment after sync',
          actor_person_id: actor.personId,
        },
      ],
    );
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.value.noop).toBe(false);
    expect(second.value.reason).toBe('Confirming assignment after sync');

    // routing_decisions — exactly one row (from step 2 only; step 1 was
    // silent). Confirms reason-with-unchanged-assignment writes audit.
    const rd = await pool.query(
      `select chosen_by, context->>'reason' as reason
         from public.routing_decisions
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(rd.rowCount).toBe(1);
    expect(rd.rows[0].chosen_by).toBe('manual_reassign');
    expect(rd.rows[0].reason).toBe('Confirming assignment after sync');

    // ticket_activities — two rows: assignment_changed (step 1) +
    // reassigned (step 2 even though assignee is unchanged).
    const acts = await pool.query(
      `select metadata->>'event' as event, content
         from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2
        order by created_at`,
      [base.tenantId, ticketId],
    );
    expect(acts.rowCount).toBe(2);
    expect(acts.rows[0].event).toBe('assignment_changed');
    expect(acts.rows[1].event).toBe('reassigned');
    expect(acts.rows[1].content).toBe('Confirming assignment after sync');
  });

  it('scenario 10: two writers, different idempotency keys, same row — serialize on SELECT FOR UPDATE not advisory lock', async () => {
    const base = await seedBaseFixture(pool, `assign-rowlock-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const { userId: userA } = await seedUser(pool, base.tenantId);
    const { userId: userB } = await seedUser(pool, base.tenantId);

    const idemA = `assign-rowlock-${ticketId}-A`;
    const idemB = `assign-rowlock-${ticketId}-B`;

    // Different keys -> different advisory-lock partitions. Confirm by
    // hashing both lock keys — they must differ. (If they collide on
    // hashtextextended the test would degenerate to scenario 1.)
    const lockA = await withClient(pool, (c) => lockKey(c, `${base.tenantId}:${idemA}`));
    const lockB = await withClient(pool, (c) => lockKey(c, `${base.tenantId}:${idemB}`));
    expect(lockA).not.toEqual(lockB);

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      await clientA.query('begin');

      // Client A: enter the RPC, take the row lock, hold the tx open.
      const aResult = await callRpc<AssignmentResult>(
        clientA,
        'public.set_entity_assignment',
        [ticketId, 'case', base.tenantId, null, idemA, { assigned_user_id: userA }],
      );
      expect(aResult.noop).toBe(false);
      expect(aResult.new_assigned_user_id).toBe(userA);

      // pg_locks for advisory keys — A's lock is granted; B's lock isn't
      // even attempted yet. Different lock partitions, no contention.
      const lockSnapshotA = await pgLocksFor(pool, lockA);
      expect(lockSnapshotA.filter((l) => l.granted).length).toBe(1);
      const lockSnapshotB_before = await pgLocksFor(pool, lockB);
      expect(lockSnapshotB_before.length).toBe(0);

      // Client B: BEGIN + start RPC. Different idempotency_key, so its
      // advisory lock acquires immediately. But it'll block on
      // SELECT FOR UPDATE waiting for A's tx.
      await clientB.query('begin');
      const bPromise = callRpc<AssignmentResult>(
        clientB,
        'public.set_entity_assignment',
        [ticketId, 'case', base.tenantId, null, idemB, { assigned_user_id: userB }],
      );

      // Wait for B to be blocked on the row lock. pg_locks for the
      // tickets relation will show B's transaction as waiting on a
      // tuple-level lock (locktype='tuple' or 'transactionid' depending
      // on PG version). We poll for any non-granted lock held by B's
      // backend on a tickets-related lock.
      const blockedDeadline = Date.now() + 5_000;
      let observedRowLockWait = false;
      while (Date.now() < blockedDeadline) {
        const r = await pool.query<{ granted: boolean; pid: number }>(
          `select pg_locks.granted, pg_locks.pid
             from pg_locks
             join pg_stat_activity sa on sa.pid = pg_locks.pid
            where sa.query like '%set_entity_assignment%'
              and pg_locks.granted = false
              and pg_locks.locktype in ('transactionid','tuple')`,
        );
        if (r.rowCount && r.rowCount > 0) {
          observedRowLockWait = true;
          break;
        }
        await new Promise((res) => setTimeout(res, 25));
      }
      expect(observedRowLockWait).toBe(true);

      // B's advisory lock IS granted (it acquired its own partition).
      const lockSnapshotB_during = await pgLocksFor(pool, lockB);
      expect(lockSnapshotB_during.filter((l) => l.granted).length).toBe(1);

      // Commit A — B unblocks, applies its UPDATE, commits.
      await clientA.query('commit');

      const bResult = await bPromise;
      await clientB.query('commit');

      // B saw the post-A state: previous_assigned_user_id = userA.
      expect(bResult.previous_assigned_user_id).toBe(userA);
      expect(bResult.new_assigned_user_id).toBe(userB);
      expect(bResult.noop).toBe(false);
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

    // Final state: row reflects B's write (the second commit wins).
    const t = await pool.query(
      'select assigned_user_id from public.tickets where id = $1',
      [ticketId],
    );
    expect(t.rows[0].assigned_user_id).toBe(userB);

    // Two command_operations rows — one per idempotency_key.
    const co = await pool.query(
      `select idempotency_key from public.command_operations
        where tenant_id = $1 and idempotency_key like $2
        order by idempotency_key`,
      [base.tenantId, `assign-rowlock-${ticketId}-%`],
    );
    expect(co.rowCount).toBe(2);

    // Two activity rows — one per write.
    const acts = await pool.query(
      `select id from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(acts.rowCount).toBe(2);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Audit 02 Slice A — set_entity_assignment v3 (migration 00416).
  //
  // v3 is an in-place replacement of v2 (00327) with three OPTIONAL
  // p_payload keys: `watchers`, `decision`, `clear_routing_status`. The
  // ten scenarios above are the v2 contract and ALL pass unchanged
  // against v3 (run baseline) — that IS the textual backward-compat
  // proof. Scenarios 11-13 below are the semantic gate codex required:
  // a textual diff can't prove the contract, so we assert it against
  // the live local SQL.
  // ──────────────────────────────────────────────────────────────────────

  it('scenario 11 (Step7a): v3 with no new keys — writes byte-identical to the v2 reason path (assignment + routing_decisions + activity + domain event)', async () => {
    const base = await seedBaseFixture(pool, `v3-compat-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const { userId } = await seedUser(pool, base.tenantId);
    const actor = await seedUser(pool, base.tenantId);

    // Reason path, NO watchers / decision / clear_routing_status keys.
    const result = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [
        ticketId,
        'case',
        base.tenantId,
        null,
        `v3-compat-${ticketId}`,
        {
          assigned_user_id: userId,
          reason: 'Workload rebalance',
          actor_person_id: actor.personId,
        },
      ],
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.noop).toBe(false);
    expect(result.value.new_assigned_user_id).toBe(userId);

    // routing_decisions — hardcoded v2 provenance: strategy='manual',
    // chosen_by='manual_reassign', rule_id NULL, context carries the
    // reason/previous/actor shape. (The v3 rule_id column addition is
    // `case ... else null end` — provably equal to v2's column omission.)
    const rd = await pool.query(
      `select strategy, chosen_by, rule_id, trace, context
         from public.routing_decisions
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(rd.rowCount).toBe(1);
    expect(rd.rows[0].strategy).toBe('manual');
    expect(rd.rows[0].chosen_by).toBe('manual_reassign');
    expect(rd.rows[0].rule_id).toBeNull();
    expect(rd.rows[0].trace).toEqual([]);
    expect(rd.rows[0].context).toEqual({
      reason: 'Workload rebalance',
      previous: {
        assigned_team_id: null,
        assigned_user_id: null,
        assigned_vendor_id: null,
      },
      actor: actor.personId,
    });

    // ticket_activities — exactly one reassigned row, v2 metadata shape
    // (short-key previous + {kind,id} next), NO `watchers` key (the
    // watcher branch never fired).
    const acts = await pool.query(
      `select metadata from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(acts.rowCount).toBe(1);
    expect(acts.rows[0].metadata.event).toBe('reassigned');
    expect(acts.rows[0].metadata.previous).toEqual({ team: null, user: null, vendor: null });
    expect(acts.rows[0].metadata.next).toEqual({ kind: 'user', id: userId });
    expect(acts.rows[0].metadata.previous).not.toHaveProperty('watchers');
    expect(acts.rows[0].metadata.next).not.toHaveProperty('watchers');

    // domain_events — exactly one ticket_assigned, payload has NO
    // previous_watchers/new_watchers keys (watcher branch inert).
    const evs = await pool.query(
      `select payload from public.domain_events
        where tenant_id = $1 and entity_id = $2 and event_type = 'ticket_assigned'`,
      [base.tenantId, ticketId],
    );
    expect(evs.rowCount).toBe(1);
    expect(evs.rows[0].payload).not.toHaveProperty('previous_watchers');
    expect(evs.rows[0].payload).not.toHaveProperty('new_watchers');
  });

  it('scenario 12 (Step7b): same idempotency_key, payload differs only by a new v3 key — raises command_operations.payload_mismatch', async () => {
    const base = await seedBaseFixture(pool, `v3-mismatch-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const { userId } = await seedUser(pool, base.tenantId);
    const watcher = await seedUser(pool, base.tenantId);

    // ── 12a: differ only by `watchers` ──────────────────────────────────
    const idemW = `v3-mismatch-w-${ticketId}`;
    const firstW = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [ticketId, 'case', base.tenantId, null, idemW, { assigned_user_id: userId }],
    );
    expect(firstW.kind).toBe('ok');
    const secondW = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [
        ticketId,
        'case',
        base.tenantId,
        null,
        idemW,
        { assigned_user_id: userId, watchers: [watcher.personId] },
      ],
    );
    expect(secondW.kind).toBe('error');
    if (secondW.kind !== 'error') return;
    expect(secondW.error.message).toMatch(/command_operations\.payload_mismatch/);

    // ── 12b: differ only by `decision` ──────────────────────────────────
    const idemD = `v3-mismatch-d-${ticketId}`;
    const firstD = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [ticketId, 'case', base.tenantId, null, idemD, { assigned_user_id: userId }],
    );
    expect(firstD.kind).toBe('ok');
    const secondD = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [
        ticketId,
        'case',
        base.tenantId,
        null,
        idemD,
        {
          assigned_user_id: userId,
          decision: { strategy: 'rule', chosen_by: 'rule' },
        },
      ],
    );
    expect(secondD.kind).toBe('error');
    if (secondD.kind !== 'error') return;
    expect(secondD.error.message).toMatch(/command_operations\.payload_mismatch/);

    // ── 12c: differ only by `clear_routing_status` ──────────────────────
    const idemC = `v3-mismatch-c-${ticketId}`;
    const firstC = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [ticketId, 'case', base.tenantId, null, idemC, { assigned_user_id: userId }],
    );
    expect(firstC.kind).toBe('ok');
    const secondC = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [
        ticketId,
        'case',
        base.tenantId,
        null,
        idemC,
        { assigned_user_id: userId, clear_routing_status: 'true' },
      ],
    );
    expect(secondC.kind).toBe('error');
    if (secondC.kind !== 'error') return;
    expect(secondC.error.message).toMatch(/command_operations\.payload_mismatch/);
  });

  it('scenario 13 (Step7c): assignment unchanged + a v3 directive — full write path runs, NOT the no-op early return', async () => {
    const base = await seedBaseFixture(pool, `v3-noop-directive-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const { userId } = await seedUser(pool, base.tenantId);

    // Step 1: assign the user (silent path) AND prime routing_status to a
    // non-idle value so the clear is observable.
    const assign = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [ticketId, 'case', base.tenantId, null, `v3-noop-directive-${ticketId}-1`, { assigned_user_id: userId }],
    );
    expect(assign.kind).toBe('ok');
    await pool.query(
      `update public.tickets
          set routing_status = 'failed', routing_failure_reason = 'probe-prime'
        where id = $1`,
      [ticketId],
    );

    // ── 13a: same assignee + clear_routing_status='true'. assignment is
    //    unchanged AND reason is null — v2 would take the no-op early
    //    return. v3's extended F17 guard must NOT: routing_status must be
    //    reset to 'idle' and routing_failure_reason cleared.
    const clear = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [
        ticketId,
        'case',
        base.tenantId,
        null,
        `v3-noop-directive-${ticketId}-2`,
        { assigned_user_id: userId, clear_routing_status: 'true' },
      ],
    );
    expect(clear.kind).toBe('ok');
    if (clear.kind !== 'ok') return;
    // Not a no-op: the directive forced the full write path.
    expect(clear.value.noop).toBe(false);

    const t = await pool.query(
      `select routing_status, routing_failure_reason, assigned_user_id
         from public.tickets where id = $1`,
      [ticketId],
    );
    expect(t.rows[0].routing_status).toBe('idle');
    expect(t.rows[0].routing_failure_reason).toBeNull();
    expect(t.rows[0].assigned_user_id).toBe(userId); // unchanged

    // An activity row was written for the clear (full write path ran,
    // early return skipped). Two total: the assign + the clear.
    const acts1 = await pool.query(
      `select id from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(acts1.rowCount).toBe(2);

    // The clear path carries NO reason and NO decision, so the
    // routing_decisions guard (v_reason is not null OR v_has_decision_key)
    // must NOT fire — zero audit rows here. Asserting it explicitly means a
    // regression where clear emits a routing_decisions row fails AT 13a with
    // a clear message, not later as a confusing 13b rowCount mismatch.
    const rdAfterClear = await pool.query(
      `select id from public.routing_decisions
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(rdAfterClear.rowCount).toBe(0);

    // ── 13b: same assignee + `decision` (no reason). v2 would no-op
    //    (assignment unchanged, reason null). v3 must run the full path
    //    AND write a routing_decisions row with the caller-supplied
    //    provenance (NOT the hardcoded 'manual'/'manual_reassign').
    const decided = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [
        ticketId,
        'case',
        base.tenantId,
        null,
        `v3-noop-directive-${ticketId}-3`,
        {
          assigned_user_id: userId,
          decision: {
            strategy: 'location',
            chosen_by: 'location_team',
            rule_id: null,
            trace: [{ step: 'location_team', matched: true }],
            context: { source: 'sla_escalation' },
          },
        },
      ],
    );
    expect(decided.kind).toBe('ok');
    if (decided.kind !== 'ok') return;
    expect(decided.value.noop).toBe(false);

    const rd = await pool.query(
      `select strategy, chosen_by, rule_id, trace, context
         from public.routing_decisions
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(rd.rowCount).toBe(1);
    expect(rd.rows[0].strategy).toBe('location');
    expect(rd.rows[0].chosen_by).toBe('location_team');
    expect(rd.rows[0].rule_id).toBeNull();
    expect(rd.rows[0].trace).toEqual([{ step: 'location_team', matched: true }]);
    expect(rd.rows[0].context).toEqual({ source: 'sla_escalation' });
  });

  it('scenario 14 (audit02 Slice A remediation): decision.rule_id that is non-existent OR belongs to another tenant raises set_entity_assignment.invalid_decision (NOT a raw 23503 / 500)', async () => {
    const base = await seedBaseFixture(pool, `v3-ruleid-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const { userId } = await seedUser(pool, base.tenantId);

    // Foreign tenant with a REAL routing_rules row. The
    // routing_decisions.rule_id FK (00027:67) is a global
    // `references public.routing_rules(id)` with no tenant scope, so a
    // cross-tenant rule_id would FK-SUCCEED without the in-function
    // tenant guard — writing another tenant's provenance into this
    // tenant's audit table. routing_rules.tenant_id is `not null`
    // (00018:5), so the §7c tenant-scoped existence check rejects it.
    const foreign = await seedBaseFixture(pool, `v3-ruleid-foreign-${Date.now()}`);
    const foreignRuleId = randomUUID();
    await withClient(pool, async (c) => {
      await c.query('begin');
      try {
        await c.query("set local session_replication_role = 'replica'");
        await c.query(
          `insert into public.routing_rules (id, tenant_id, name, priority, active)
           values ($1, $2, 'Foreign-tenant rule', 0, true)`,
          [foreignRuleId, foreign.tenantId],
        );
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    });
    // Registered LAST → runs FIRST in the LIFO flush, before the foreign
    // base fixture deletes its tenant (routing_rules.tenant_id FK has no
    // ON DELETE CASCADE).
    registerCleanup(async () => {
      await withClient(pool, async (c) => {
        await c.query('begin');
        try {
          await c.query("set local session_replication_role = 'replica'");
          await c.query('delete from public.routing_rules where id = $1', [foreignRuleId]);
          await c.query('commit');
        } catch (e) {
          await c.query('rollback');
          throw e;
        }
      });
    });

    // ── 14a: syntactically-valid but NON-EXISTENT rule_id. Without the
    //    §7c guard this hits the routing_decisions INSERT and raises raw
    //    Postgres 23503 (foreign_key_violation), which extractCode
    //    (map-rpc-error.ts:436-442) cannot parse → 500
    //    unknown.server_error. With the guard it raises the registered
    //    set_entity_assignment.invalid_decision (a curated 400).
    const ghostRuleId = randomUUID();
    const nonExistent = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [
        ticketId,
        'case',
        base.tenantId,
        null,
        `v3-ruleid-ghost-${ticketId}`,
        {
          assigned_user_id: userId,
          decision: {
            strategy: 'rule',
            chosen_by: 'rule',
            rule_id: ghostRuleId,
          },
        },
      ],
    );
    expect(nonExistent.kind).toBe('error');
    if (nonExistent.kind !== 'error') return;
    expect(nonExistent.error.message).toMatch(
      /set_entity_assignment\.invalid_decision/,
    );
    // Definitively NOT the raw FK-violation sqlstate / generic 500 path.
    expect(nonExistent.error.message).not.toMatch(/23503/);
    expect(nonExistent.error.message).not.toMatch(/foreign key/i);

    // ── 14b: rule_id that EXISTS but belongs to a DIFFERENT tenant. The
    //    global FK would accept it; the tenant-scoped existence check
    //    must reject it with the same registered code (cross-tenant
    //    isolation — #0 invariant).
    const crossTenant = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [
        ticketId,
        'case',
        base.tenantId,
        null,
        `v3-ruleid-cross-${ticketId}`,
        {
          assigned_user_id: userId,
          decision: {
            strategy: 'rule',
            chosen_by: 'rule',
            rule_id: foreignRuleId,
          },
        },
      ],
    );
    expect(crossTenant.kind).toBe('error');
    if (crossTenant.kind !== 'error') return;
    expect(crossTenant.error.message).toMatch(
      /set_entity_assignment\.invalid_decision/,
    );
    expect(crossTenant.error.message).not.toMatch(/23503/);
    expect(crossTenant.error.message).not.toMatch(/foreign key/i);

    // Non-vacuous: NO routing_decisions row was written for either reject
    // (the guard fires before the INSERT) AND no cross-tenant leak landed.
    const rd = await pool.query(
      `select id from public.routing_decisions where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(rd.rowCount).toBe(0);

    // ── 14c: positive control — a rule_id that DOES exist in THIS tenant
    //    passes the guard and the decision row is written with it. Proves
    //    the check is a tenant filter, not a blanket rule_id rejection.
    const ownRuleId = randomUUID();
    await withClient(pool, async (c) => {
      await c.query('begin');
      try {
        await c.query("set local session_replication_role = 'replica'");
        await c.query(
          `insert into public.routing_rules (id, tenant_id, name, priority, active)
           values ($1, $2, 'Own-tenant rule', 0, true)`,
          [ownRuleId, base.tenantId],
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
          await c.query('delete from public.routing_rules where id = $1', [ownRuleId]);
          await c.query('commit');
        } catch (e) {
          await c.query('rollback');
          throw e;
        }
      });
    });

    const accepted = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [
        ticketId,
        'case',
        base.tenantId,
        null,
        `v3-ruleid-own-${ticketId}`,
        {
          assigned_user_id: userId,
          decision: {
            strategy: 'rule',
            chosen_by: 'rule',
            rule_id: ownRuleId,
          },
        },
      ],
    );
    expect(accepted.kind).toBe('ok');
    if (accepted.kind !== 'ok') return;
    expect(accepted.value.noop).toBe(false);

    const rdOk = await pool.query(
      `select rule_id, strategy, chosen_by
         from public.routing_decisions
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(rdOk.rowCount).toBe(1);
    expect(rdOk.rows[0].rule_id).toBe(ownRuleId);
    expect(rdOk.rows[0].strategy).toBe('rule');
    expect(rdOk.rows[0].chosen_by).toBe('rule');
  });

  // ──────────────────────────────────────────────────────────────────────
  // Audit 02 Slice D follow-up — D-A02-2 (migration 00418, v3.1).
  //
  // Bug: 00416 v3's decision-path routing_decisions INSERT sourced
  // chosen_team_id/chosen_user_id/chosen_vendor_id from v_new_* (the
  // post-write assignment columns). When the `assigned_*` keys are ABSENT
  // from p_payload, v_new_* := v_prev_* (00416:255-257) — so a resolver
  // `unassigned` outcome (decision.chosen_by='unassigned', no assigned_*
  // keys) against an ALREADY-ASSIGNED ticket wrote the ticket's STALE
  // current assignee into routing_decisions.chosen_* on a row whose
  // chosen_by='unassigned'. The OLD standalone handler insert
  // (4b77af30~1) wrote chosen_*=NULL here. Silent audit regression.
  //
  // Fix (v3.1, 00418): on the decision path, chosen_* is sourced from the
  // decision object (nullif(v_decision->>'chosen_team_id','')::uuid etc.)
  // — the resolver's chosen target — NOT v_new_*. Provenance is now
  // decoupled from the assignment write. Non-decision path byte-identical.
  // ──────────────────────────────────────────────────────────────────────

  it('scenario 15 (D-A02-2): unassigned-outcome decision (no assigned_* keys) against an assigned ticket — chosen_* ALL NULL, assignment UNCHANGED', async () => {
    const base = await seedBaseFixture(pool, `v3_1-unassigned-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);
    const { userId: teamMember } = await seedUser(pool, base.tenantId);

    // Seed a real team T and pre-assign the ticket to it.
    const teamId = randomUUID();
    await withClient(pool, async (c) => {
      await c.query('begin');
      try {
        await c.query("set local session_replication_role = 'replica'");
        await c.query(
          `insert into public.teams (id, tenant_id, name) values ($1, $2, 'D-A02-2 team T')`,
          [teamId, base.tenantId],
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
          await c.query('delete from public.teams where id = $1', [teamId]);
          await c.query('commit');
        } catch (e) {
          await c.query('rollback');
          throw e;
        }
      });
    });
    void teamMember;

    // Step 1: assign the ticket to team T (silent path).
    const assign = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [ticketId, 'case', base.tenantId, null, `v3_1-unassigned-${ticketId}-1`, { assigned_team_id: teamId }],
    );
    expect(assign.kind).toBe('ok');
    if (assign.kind !== 'ok') return;
    expect(assign.value.new_assigned_team_id).toBe(teamId);

    // Step 2: the routing-evaluation handler's unassigned-outcome shape —
    // decision present with chosen_by='unassigned' and chosen_* all null,
    // NO assigned_* keys (assignment preservation), clear_routing_status.
    const unassigned = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [
        ticketId,
        'case',
        base.tenantId,
        null,
        `v3_1-unassigned-${ticketId}-2`,
        {
          clear_routing_status: 'true',
          decision: {
            strategy: 'auto',
            chosen_by: 'unassigned',
            rule_id: null,
            trace: [],
            context: {},
            chosen_team_id: null,
            chosen_user_id: null,
            chosen_vendor_id: null,
          },
        },
      ],
    );
    expect(unassigned.kind).toBe('ok');
    if (unassigned.kind !== 'ok') return;

    // (i) Assignment UNCHANGED — assigned_* keys absent ⇒ no change.
    const t = await pool.query(
      'select assigned_team_id, assigned_user_id, assigned_vendor_id from public.tickets where id = $1',
      [ticketId],
    );
    expect(t.rows[0].assigned_team_id).toBe(teamId);
    expect(t.rows[0].assigned_user_id).toBeNull();
    expect(t.rows[0].assigned_vendor_id).toBeNull();

    // (ii) routing_decisions row for the unassigned outcome: chosen_* ALL
    // NULL (sourced from the decision object, NOT the stale v_new_*=teamId),
    // chosen_by='unassigned'. This is the regression oracle — pre-v3.1
    // chosen_team_id would equal teamId.
    const rd = await pool.query(
      `select chosen_by, strategy, chosen_team_id, chosen_user_id, chosen_vendor_id
         from public.routing_decisions
        where tenant_id = $1 and ticket_id = $2 and chosen_by = 'unassigned'`,
      [base.tenantId, ticketId],
    );
    expect(rd.rowCount).toBe(1);
    expect(rd.rows[0].chosen_by).toBe('unassigned');
    expect(rd.rows[0].strategy).toBe('auto');
    expect(rd.rows[0].chosen_team_id).toBeNull();
    expect(rd.rows[0].chosen_user_id).toBeNull();
    expect(rd.rows[0].chosen_vendor_id).toBeNull();
  });

  it('scenario 16 (D-A02-2): decision with a real resolver pick (chosen_team_id=X) + assigned_team_id=X — routing_decisions.chosen_team_id = X (decision-sourced, still correct for the real-target path)', async () => {
    const base = await seedBaseFixture(pool, `v3_1-picked-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);

    const teamX = randomUUID();
    await withClient(pool, async (c) => {
      await c.query('begin');
      try {
        await c.query("set local session_replication_role = 'replica'");
        await c.query(
          `insert into public.teams (id, tenant_id, name) values ($1, $2, 'D-A02-2 team X')`,
          [teamX, base.tenantId],
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
          await c.query('delete from public.teams where id = $1', [teamX]);
          await c.query('commit');
        } catch (e) {
          await c.query('rollback');
          throw e;
        }
      });
    });

    // Resolver picked team X; the caller sends both the assignment write
    // (assigned_team_id=X) AND a decision carrying chosen_team_id=X.
    const picked = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [
        ticketId,
        'case',
        base.tenantId,
        null,
        `v3_1-picked-${ticketId}`,
        {
          assigned_team_id: teamX,
          clear_routing_status: 'true',
          decision: {
            strategy: 'rule',
            chosen_by: 'rule',
            rule_id: null,
            trace: [],
            context: {},
            chosen_team_id: teamX,
            chosen_user_id: null,
            chosen_vendor_id: null,
          },
        },
      ],
    );
    expect(picked.kind).toBe('ok');
    if (picked.kind !== 'ok') return;
    expect(picked.value.new_assigned_team_id).toBe(teamX);

    const rd = await pool.query(
      `select chosen_by, strategy, chosen_team_id, chosen_user_id, chosen_vendor_id
         from public.routing_decisions
        where tenant_id = $1 and ticket_id = $2 and chosen_by = 'rule'`,
      [base.tenantId, ticketId],
    );
    expect(rd.rowCount).toBe(1);
    expect(rd.rows[0].chosen_team_id).toBe(teamX); // decision-sourced
    expect(rd.rows[0].chosen_user_id).toBeNull();
    expect(rd.rows[0].chosen_vendor_id).toBeNull();
  });

  it('scenario 17 (D-A02-2): caller-supplied chosen_team_id from another tenant raises set_entity_assignment.invalid_decision (NOT raw 23503 / 500)', async () => {
    const base = await seedBaseFixture(pool, `v3_1-xtenant-${Date.now()}`);
    const { ticketId } = await seedCase(pool, base);

    const foreign = await seedBaseFixture(pool, `v3_1-xtenant-foreign-${Date.now()}`);
    const foreignTeamId = randomUUID();
    await withClient(pool, async (c) => {
      await c.query('begin');
      try {
        await c.query("set local session_replication_role = 'replica'");
        await c.query(
          `insert into public.teams (id, tenant_id, name) values ($1, $2, 'Foreign-tenant team')`,
          [foreignTeamId, foreign.tenantId],
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
          await c.query('delete from public.teams where id = $1', [foreignTeamId]);
          await c.query('commit');
        } catch (e) {
          await c.query('rollback');
          throw e;
        }
      });
    });

    // chosen_team_id references a team in ANOTHER tenant. The
    // routing_decisions.chosen_team_id FK (00027:63) is a global
    // `references public.teams(id)` with no tenant scope — without the
    // v3.1 tenant guard this FK-SUCCEEDS and writes cross-tenant
    // provenance (a #0-invariant breach). The guard must raise the
    // registered set_entity_assignment.invalid_decision (curated 400),
    // never a raw 23503 / generic 500.
    const xTenant = await runRpcCapture<AssignmentResult>(
      pool,
      'public.set_entity_assignment',
      [
        ticketId,
        'case',
        base.tenantId,
        null,
        `v3_1-xtenant-${ticketId}`,
        {
          assigned_team_id: null,
          clear_routing_status: 'true',
          decision: {
            strategy: 'rule',
            chosen_by: 'rule',
            rule_id: null,
            trace: [],
            context: {},
            chosen_team_id: foreignTeamId,
            chosen_user_id: null,
            chosen_vendor_id: null,
          },
        },
      ],
    );
    expect(xTenant.kind).toBe('error');
    if (xTenant.kind !== 'error') return;
    expect(xTenant.error.message).toMatch(/set_entity_assignment\.invalid_decision/);
    expect(xTenant.error.message).not.toMatch(/23503/);
    expect(xTenant.error.message).not.toMatch(/foreign key/i);

    // No routing_decisions row written (guard fires before the INSERT).
    const rd = await pool.query(
      `select id from public.routing_decisions where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(rd.rowCount).toBe(0);
  });
});

export {};
