/**
 * B.2.A.6 concurrency probe — set_entity_assignment.
 *
 * Spec ref: docs/follow-ups/b2-survey-and-design.md §3.2 (lines 1986-2037).
 * Migration: supabase/migrations/00326_set_entity_assignment_rpc.sql.
 * Harness pattern mirrors transition_entity_status.spec.ts (00323 / 00325).
 *
 * Six scenarios, all against the live local Supabase stack:
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
 *      NO routing_decisions row written.
 *   5. Reassign with reason — payload includes `reason`;
 *      ticket_activities row has metadata.event='reassigned';
 *      routing_decisions row exists with chosen_by='manual_reassign'.
 *   6. rerun_resolver rejected — payload has `rerun_resolver=true`;
 *      raises 'set_entity_assignment.resolver_rerun_not_supported_at_rpc'.
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

  it('scenario 4: silent assignment (no reason) — one assignment_changed activity, no routing_decisions row', async () => {
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

    // ticket_activities — exactly one assignment_changed row.
    const acts = await pool.query(
      `select metadata->>'event' as event, visibility, content
         from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(acts.rowCount).toBe(1);
    expect(acts.rows[0].event).toBe('assignment_changed');
    expect(acts.rows[0].visibility).toBe('system');
    expect(acts.rows[0].content).toBeNull();

    // routing_decisions — none (silent path skips audit row).
    const rd = await pool.query(
      'select id from public.routing_decisions where tenant_id = $1 and ticket_id = $2',
      [base.tenantId, ticketId],
    );
    expect(rd.rowCount).toBe(0);

    // outbox.events — one ticket_assigned event emitted.
    const evs = await pool.query(
      `select event_type from outbox.events
        where tenant_id = $1 and aggregate_id = $2 and event_type = 'ticket_assigned'`,
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
    const acts = await pool.query(
      `select metadata->>'event' as event, visibility, content, author_person_id
         from public.ticket_activities
        where tenant_id = $1 and ticket_id = $2`,
      [base.tenantId, ticketId],
    );
    expect(acts.rowCount).toBe(1);
    expect(acts.rows[0].event).toBe('reassigned');
    expect(acts.rows[0].visibility).toBe('internal');
    expect(acts.rows[0].content).toBe('Workload rebalance');
    expect(acts.rows[0].author_person_id).toBe(actorPerson.personId);

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
});

export {};
