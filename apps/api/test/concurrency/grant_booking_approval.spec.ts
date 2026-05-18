/**
 * B.0 concurrency probe — grant_booking_approval.
 *
 * Spec ref: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §15.6
 * + §10.1 (lock ordering, v8.1-I2 SELECT FOR UPDATE before CAS).
 * Harness ref: docs/follow-ups/b0-real-db-concurrency-harness.md.
 *
 * Two scenarios per spec §15.6:
 *
 * 1. Concurrent grants on the SAME approval_id:
 *    - First wins → kind='resolved' (or 'partial_approved' if siblings).
 *    - Second blocks on the per-approval advisory lock then on the
 *      FOR UPDATE row read; on entry sees status<>'pending' and
 *      returns kind='already_responded'.
 *
 * 2. Concurrent grants on DIFFERENT approval_id values within the
 *    SAME booking parallel-group:
 *    - Per-approval advisory keys differ → the second clears step 1
 *      without contending there.
 *    - Per-booking serialisation in v3 (00426 step 2, BLOCKER-2
 *      closure) is a `SELECT ... FROM bookings ... FOR UPDATE` ROW
 *      lock — NOT the pre-00403 per-booking ADVISORY lock. The second
 *      blocks on that row lock (held by the first's open txn) until
 *      the first commits. Observed via pg_stat_activity +
 *      pg_blocking_pids (waitForRowLockBlocker), since the advisory-
 *      only pgLocksFor/waitForBlocker helpers cannot see a row lock.
 *    - The second's v_unresolved_count then reads MVCC-post-commit
 *      and decides resolution correctly (no pending siblings → final
 *      kind='resolved').
 */

import { Pool } from 'pg';
import {
  callRpc,
  flushAllFixtures,
  lockKey,
  pgLocksFor,
  seedApproval,
  seedBaseFixture,
  seedPendingApprovalBooking,
  seedSecondApprover,
  waitForBlocker,
  waitForRowLockBlocker,
  withClient,
} from './helpers';
import { endPool, getPool } from './pool';

describe('grant_booking_approval — concurrent grants', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = getPool();
  });

  afterAll(async () => {
    await flushAllFixtures(pool);
    await endPool();
  });

  it('two grants on the SAME approval_id: first resolves, second returns already_responded', async () => {
    const base = await seedBaseFixture(pool, `grant-same-${Date.now()}`);
    const seeded = await seedPendingApprovalBooking(pool, base);
    const { approvalId } = await seedApproval(pool, base, seeded.bookingId);

    const idemA = `grant-same-A-${approvalId}`;
    const idemB = `grant-same-B-${approvalId}`;

    // Per-approval lock key — B will block on this.
    const approvalLockKey = await withClient(pool, (c) =>
      lockKey(c, `${base.tenantId}:approval:${approvalId}`),
    );

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      await clientA.query('begin');

      // Sanity: no leaked lock.
      expect((await pgLocksFor(pool, approvalLockKey)).filter((l) => l.granted).length).toBe(0);

      // A enters first, returns the resolved record (single approval
      // → 0 unresolved siblings → confirmed booking).
      const aResult = await callRpc<{ kind: string; final_decision?: string }>(
        clientA,
        'public.grant_booking_approval',
        [approvalId, base.tenantId, null, 'approved', null, idemA],
      );
      expect(aResult.kind).toBe('resolved');
      expect(aResult.final_decision).toBe('approved');

      // A still holds the per-approval lock until commit.
      expect((await pgLocksFor(pool, approvalLockKey)).filter((l) => l.granted).length).toBe(1);

      // B starts in the background — must block on the per-approval lock.
      await clientB.query('begin');
      const bPromise = callRpc<{ kind: string; prior_status?: string }>(
        clientB,
        'public.grant_booking_approval',
        [approvalId, base.tenantId, null, 'approved', null, idemB],
      );

      await waitForBlocker(pool, approvalLockKey, { timeoutMs: 5_000 });
      const duringContention = await pgLocksFor(pool, approvalLockKey);
      expect(duringContention.some((l) => !l.granted)).toBe(true);

      // Commit A → B unblocks. The state-machine guard at v8.1-I2
      // (status<>'pending') runs BEFORE any mutation, so B returns
      // already_responded WITHOUT raising 23505 or a CAS-lost error.
      await clientA.query('commit');

      const bResult = await bPromise;
      await clientB.query('commit');

      expect(bResult.kind).toBe('already_responded');
      expect(bResult.prior_status).toBe('approved');
    } finally {
      try {
        await clientA.query('rollback');
      } catch {
        /* already finalised */
      }
      try {
        await clientB.query('rollback');
      } catch {
        /* already finalised */
      }
      clientA.release();
      clientB.release();
    }

    // Booking is confirmed; only the first grant left a single
    // domain_event on the approval (B was a no-op, no event written).
    const bk = await pool.query('select status from public.bookings where id = $1', [
      seeded.bookingId,
    ]);
    expect(bk.rows[0].status).toBe('confirmed');
    const events = await pool.query(
      `select event_type from public.domain_events
        where tenant_id = $1 and entity_type = 'approval' and entity_id = $2`,
      [base.tenantId, seeded.bookingId],
    );
    expect(events.rowCount).toBe(1);
    expect(events.rows[0].event_type).toBe('approval_approved');
  });

  it('two grants on DIFFERENT approval_id values within same booking: booking-level lock serialises, second resolves correctly post-commit', async () => {
    const base = await seedBaseFixture(pool, `grant-different-${Date.now()}`);
    const seeded = await seedPendingApprovalBooking(pool, base);
    const { approvalId: approvalAId } = await seedApproval(pool, base, seeded.bookingId, {
      parallelGroup: 'group1',
    });
    const { approvalId: approvalBId } = await seedSecondApprover(pool, base, seeded.bookingId, {
      parallelGroup: 'group1',
    });

    // Per-booking serialisation in grant_booking_approval v3
    // (00426 step 2, BLOCKER-2 closure) is a `SELECT ... FROM bookings
    // ... FOR UPDATE` ROW lock — NOT the per-booking ADVISORY lock the
    // pre-00403 00310 RPC used. The advisory-only pgLocksFor /
    // waitForBlocker helpers cannot observe a row lock; contention is
    // observed via pg_stat_activity (waitForRowLockBlocker) +
    // pg_blocking_pids instead. Do NOT reintroduce a bookingLockKey
    // advisory assertion here — v3 takes no per-booking advisory lock.
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      // A starts first and, inside grant_booking_approval, takes the
      // per-approval advisory lock (step 1) then the bookings-row
      // FOR UPDATE (step 2) which its open transaction keeps held.
      await clientA.query('begin');
      const aPid = (
        await clientA.query<{ pid: number }>('select pg_backend_pid() as pid')
      ).rows[0].pid;
      const aResult = await callRpc<{ kind: string; remaining?: number }>(
        clientA,
        'public.grant_booking_approval',
        [approvalAId, base.tenantId, null, 'approved', null, `grant-diff-A-${approvalAId}`],
      );
      expect(aResult.kind).toBe('partial_approved');
      expect(aResult.remaining).toBe(1);

      // B starts — its per-approval advisory key differs from A's, so B
      // clears step 1, then BLOCKS at step 2 on the bookings row lock
      // A's still-open transaction holds.
      await clientB.query('begin');
      const bPid = (
        await clientB.query<{ pid: number }>('select pg_backend_pid() as pid')
      ).rows[0].pid;
      const bPromise = callRpc<{ kind: string; final_decision?: string; new_status?: string }>(
        clientB,
        'public.grant_booking_approval',
        [approvalBId, base.tenantId, null, 'approved', null, `grant-diff-B-${approvalBId}`],
      );

      // Deterministic contention proof: B is parked in a row-level Lock
      // wait, and A's backend is the one blocking it. 15s (not the
      // harness-default 5s) tolerates a loaded ubuntu-latest CI runner —
      // waitForRowLockBlocker polls real pg_stat_activity state and
      // returns the instant B blocks, so a larger ceiling only avoids a
      // false negative; it cannot mask a genuine no-contention failure.
      await waitForRowLockBlocker(pool, bPid, { timeoutMs: 15_000 });
      const blockers = await pool.query<{ blockers: number[] }>(
        'select pg_blocking_pids($1) as blockers',
        [bPid],
      );
      expect(blockers.rows[0].blockers).toContain(aPid);

      // Commit A → the bookings row lock releases; B acquires it and
      // re-reads sibling counts under a fresh snapshot that includes
      // A's commit. Both approvals 'approved' now → unresolved=0 →
      // kind='resolved'.
      await clientA.query('commit');

      const bResult = await bPromise;
      await clientB.query('commit');

      expect(bResult.kind).toBe('resolved');
      expect(bResult.final_decision).toBe('approved');
      expect(bResult.new_status).toBe('confirmed');
    } finally {
      try {
        await clientA.query('rollback');
      } catch {
        /* already finalised */
      }
      try {
        await clientB.query('rollback');
      } catch {
        /* already finalised */
      }
      clientA.release();
      clientB.release();
    }

    // Booking transitioned to confirmed AFTER the second grant — the
    // first returned partial_approved without flipping booking status.
    const bk = await pool.query('select status from public.bookings where id = $1', [
      seeded.bookingId,
    ]);
    expect(bk.rows[0].status).toBe('confirmed');

    // Both approvals are 'approved'.
    const apprs = await pool.query(
      `select status from public.approvals
        where tenant_id = $1 and target_entity_id = $2 order by id`,
      [base.tenantId, seeded.bookingId],
    );
    expect(apprs.rowCount).toBe(2);
    expect(apprs.rows.every((r) => r.status === 'approved')).toBe(true);
  });
});

export {};
