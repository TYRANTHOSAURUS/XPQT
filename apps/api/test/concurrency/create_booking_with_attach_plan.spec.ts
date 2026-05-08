/**
 * B.0 concurrency probe — create_booking_with_attach_plan.
 *
 * Spec ref: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §15.2.
 * Harness ref: docs/follow-ups/b0-real-db-concurrency-harness.md.
 *
 * Scenario: concurrent retries with the SAME idempotency_key serialise
 * via pg_advisory_xact_lock. The second connection MUST block until
 * the first commits, then read the committed attach_operations row
 * and return cached_result — NOT a 23505 unique-violation.
 *
 * Method:
 *   - Client A: BEGIN, run the RPC. The RPC acquires
 *     hashtextextended(tenant_id || ':' || key, 0) at step 1, then
 *     writes booking + slots + orders + OLIs and the attach_operations
 *     marker. We wrap A in a transaction the harness commits, but the
 *     RPC's own pg_advisory_xact_lock auto-releases on commit.
 *   - Client B: BEGIN, run the same RPC with the same args. B's lock
 *     attempt blocks behind A's lock. We assert via pg_locks.
 *   - Commit A. B unblocks, re-reads attach_operations (which now has
 *     outcome='success' + cached_result), returns the cached value.
 *   - Assert: B's result === A's result; only one bookings row;
 *     attach_operations.outcome='success' once.
 *
 * The harness uses two pool clients so the advisory lock is genuinely
 * cross-connection (in-process serialisation via session locks would
 * be a false pass).
 */

import { Pool } from 'pg';
import {
  buildSimpleBookingPlan,
  callRpc,
  flushAllFixtures,
  lockKey,
  pgLocksFor,
  seedBaseFixture,
  waitForBlocker,
  withClient,
} from './helpers';
import { endPool, getPool } from './pool';

describe('create_booking_with_attach_plan — concurrent retry idempotency', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = getPool();
  });

  afterAll(async () => {
    await flushAllFixtures(pool);
    await endPool();
  });

  it('two retries with the same idempotency_key return the same cached_result; second blocks on advisory lock', async () => {
    const base = await seedBaseFixture(pool, `create-${Date.now()}`);
    const plan = buildSimpleBookingPlan({
      tenantId: base.tenantId,
      personId: base.personId,
      spaceId: base.spaceId,
      catalogItemId: base.catalogItemId,
    });
    const idempotencyKey = `concurrency-create-${plan.bookingId}`;

    // Compute the lock key the RPC will derive at step 1.
    const probeKey = await withClient(pool, (c) =>
      lockKey(c, `${base.tenantId}:${idempotencyKey}`),
    );

    // ── Client A: BEGIN, call the RPC, but DON'T commit yet so we
    // can prove client B blocks behind A's advisory lock.
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      await clientA.query('begin');

      // Sanity: nobody is holding the lock yet.
      const before = await pgLocksFor(pool, probeKey);
      expect(before.filter((l) => l.granted).length).toBe(0);

      // A enters the RPC. It will acquire the advisory lock + insert
      // the in-progress marker + write booking + ... and return.
      const aResult = await callRpc<Record<string, unknown>>(
        clientA,
        'public.create_booking_with_attach_plan',
        [plan.bookingInput, plan.attachPlan, base.tenantId, idempotencyKey],
      );
      expect(aResult).toBeTruthy();
      expect((aResult as { booking_id?: string }).booking_id).toBe(plan.bookingId);

      // After the RPC returns, A still owns the advisory lock (it's
      // pg_advisory_xact_lock — released on COMMIT/ROLLBACK).
      const duringA = await pgLocksFor(pool, probeKey);
      expect(duringA.filter((l) => l.granted).length).toBe(1);

      // ── Client B: BEGIN + start the RPC in the BACKGROUND. It must
      // block on the advisory lock.
      await clientB.query('begin');
      const bPromise = callRpc<Record<string, unknown>>(
        clientB,
        'public.create_booking_with_attach_plan',
        [plan.bookingInput, plan.attachPlan, base.tenantId, idempotencyKey],
      );

      // Assert via pg_locks that B is now waiting (granted=false).
      await waitForBlocker(pool, probeKey, { timeoutMs: 5_000 });
      const duringContention = await pgLocksFor(pool, probeKey);
      expect(duringContention.some((l) => !l.granted)).toBe(true);
      expect(duringContention.filter((l) => l.granted).length).toBe(1);

      // ── Commit A. B unblocks, re-enters its tx, and returns
      // cached_result (NOT a 23505 violation; spec §15.2).
      await clientA.query('commit');

      const bResult = await bPromise;
      // B is still inside its own tx (it called the RPC but the harness
      // didn't commit yet); commit so the test ends cleanly.
      await clientB.query('commit');

      // Cached result equality: every primitive field matches A's
      // result by string-equal comparison (jsonb returns plain JS).
      expect(bResult).toEqual(aResult);
    } finally {
      // Roll back any open tx defensively.
      try {
        await clientA.query('rollback');
      } catch {
        /* tx already committed/rolled back */
      }
      try {
        await clientB.query('rollback');
      } catch {
        /* tx already committed/rolled back */
      }
      clientA.release();
      clientB.release();
    }

    // ── Outcome assertions on committed state.
    const bookings = await pool.query(
      'select id, status from public.bookings where id = $1',
      [plan.bookingId],
    );
    expect(bookings.rowCount).toBe(1);
    expect(bookings.rows[0].status).toBe('confirmed');

    const ao = await pool.query(
      `select outcome, cached_result is not null as has_cached
         from public.attach_operations
        where tenant_id = $1 and idempotency_key = $2`,
      [base.tenantId, idempotencyKey],
    );
    expect(ao.rowCount).toBe(1);
    expect(ao.rows[0].outcome).toBe('success');
    expect(ao.rows[0].has_cached).toBe(true);

    // Only one OLI was inserted across both retries (spec §7.3 v6).
    const oliCount = await pool.query(
      'select count(*)::int as n from public.order_line_items where tenant_id = $1',
      [base.tenantId],
    );
    expect(oliCount.rows[0].n).toBe(1);
  });
});

export {};
