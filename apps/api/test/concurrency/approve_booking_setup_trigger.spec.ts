/**
 * B.0 concurrency probe — approve_booking_setup_trigger.
 *
 * Spec ref: docs/superpowers/specs/2026-05-04-domain-outbox-design.md
 * §15.5 / §15.6 (concurrent grants serialise OLI processing; no
 * double-emit, no skipped emit).
 * Harness ref: docs/follow-ups/b0-real-db-concurrency-harness.md.
 *
 * Scenario: two approvers fan-out simultaneously to the same booking.
 * Both reach the standalone setup-trigger RPC. The per-booking
 * advisory lock at step 1 (`hashtextextended(<tenant>:approve_setup:<booking_id>, 0)`)
 * serialises them. The first reads + emits + clears the OLI's
 * pending_setup_trigger_args. The second blocks on the lock; on
 * unblock it FOR-UPDATEs every OLI in the booking, sees
 * pending_setup_trigger_args IS NULL on every row (the first cleared
 * them), emits zero, returns emitted_count=0.
 *
 * Outcome: exactly ONE outbox event for the OLI. No double-emit, no
 * skipped-emit on a row that the first call processed.
 */

import { Pool } from 'pg';
import {
  callRpc,
  flushAllFixtures,
  lockKey,
  pgLocksFor,
  seedBaseFixture,
  seedPendingApprovalBooking,
  waitForBlocker,
  withClient,
} from './helpers';
import { endPool, getPool } from './pool';

describe('approve_booking_setup_trigger — concurrent grants serialise OLI processing', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = getPool();
  });

  afterAll(async () => {
    await flushAllFixtures(pool);
    await endPool();
  });

  it('two concurrent calls emit exactly one outbox event; second returns emitted_count=0', async () => {
    const base = await seedBaseFixture(pool, `setup-trigger-${Date.now()}`);
    const seeded = await seedPendingApprovalBooking(pool, base, {
      withPendingSetupArgs: true,
    });

    const probeKey = await withClient(pool, (c) =>
      lockKey(c, `${base.tenantId}:approve_setup:${seeded.bookingId}`),
    );

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      await clientA.query('begin');

      // A enters first, emits one event, clears pending_setup_trigger_args.
      const aResult = await callRpc<{
        emitted_count: number;
        skipped_cancelled: number;
        skipped_no_args: number;
      }>(
        clientA,
        'public.approve_booking_setup_trigger',
        [seeded.bookingId, base.tenantId, null, `setup-trigger-A-${seeded.bookingId}`],
      );
      expect(aResult.emitted_count).toBe(1);

      // A still holds the per-booking advisory lock until commit.
      expect((await pgLocksFor(pool, probeKey)).filter((l) => l.granted).length).toBe(1);

      // B starts in the background — must block on the same key.
      await clientB.query('begin');
      const bPromise = callRpc<{
        emitted_count: number;
        skipped_cancelled: number;
        skipped_no_args: number;
      }>(
        clientB,
        'public.approve_booking_setup_trigger',
        [seeded.bookingId, base.tenantId, null, `setup-trigger-B-${seeded.bookingId}`],
      );

      await waitForBlocker(pool, probeKey, { timeoutMs: 5_000 });
      const duringContention = await pgLocksFor(pool, probeKey);
      expect(duringContention.some((l) => !l.granted)).toBe(true);
      expect(duringContention.filter((l) => l.granted).length).toBe(1);

      // Commit A → B unblocks. B's FOR UPDATE OF oli read sees the
      // post-commit snapshot where pending_setup_trigger_args IS NULL,
      // so its loop short-circuits with skipped_no_args+=1 and
      // emitted_count=0.
      await clientA.query('commit');

      const bResult = await bPromise;
      await clientB.query('commit');

      expect(bResult.emitted_count).toBe(0);
      expect(bResult.skipped_no_args).toBe(1);
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

    // Exactly ONE outbox event landed for the OLI.
    const events = await pool.query(
      `select count(*)::int as n
         from outbox.events
        where tenant_id = $1
          and event_type = 'setup_work_order.create_required'
          and aggregate_id = $2`,
      [base.tenantId, seeded.oliId],
    );
    expect(events.rows[0].n).toBe(1);

    // OLI's pending args are now NULL.
    const oliRow = await pool.query(
      'select pending_setup_trigger_args from public.order_line_items where id = $1',
      [seeded.oliId],
    );
    expect(oliRow.rows[0].pending_setup_trigger_args).toBeNull();

    // Two audit rows (one per RPC invocation), one of them with emitted=0.
    const audits = await pool.query(
      `select details->>'emitted' as emitted, details->>'skipped_no_args' as skipped_no_args
         from public.audit_events
        where tenant_id = $1
          and event_type = 'booking.deferred_setup_emitted_on_approval'
          and entity_id = $2
        order by created_at`,
      [base.tenantId, seeded.bookingId],
    );
    expect(audits.rowCount).toBe(2);
    expect(audits.rows[0].emitted).toBe('1');
    expect(audits.rows[1].emitted).toBe('0');
    expect(audits.rows[1].skipped_no_args).toBe('1');
  });
});

export {};
