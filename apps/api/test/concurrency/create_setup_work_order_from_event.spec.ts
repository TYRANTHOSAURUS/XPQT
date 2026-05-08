/**
 * B.0 concurrency probe — create_setup_work_order_from_event.
 *
 * Spec ref: docs/superpowers/specs/2026-05-04-domain-outbox-design.md
 * §15.5 (concurrent handler dispatch — two workers somehow claim the
 * same event).
 * Harness ref: docs/follow-ups/b0-real-db-concurrency-harness.md.
 *
 * Scenario: two workers each claimed the same outbox event (forced
 * via stale-claim recovery in the spec). Both miss the read-side
 * dedup (the dedup row doesn't exist yet); both call the RPC. The
 * RPC's per-OLI advisory lock at step 5 (`<tenant>:setup_wo:<oli_id>`)
 * serialises them.
 *
 *   - Worker A acquires the lock, inserts work_orders + the dedup row
 *     atomically, returns kind='created' with the new work_order_id.
 *   - Worker B blocks on the same lock; on unblock, the FOR UPDATE
 *     read of setup_work_order_emissions returns the row A just
 *     committed → returns kind='already_created' with the SAME id.
 *   - Exactly ONE work_orders row exists for the OLI.
 */

import { Pool } from 'pg';
import {
  buildSetupWoRowData,
  callRpc,
  flushAllFixtures,
  lockKey,
  pgLocksFor,
  seedBaseFixture,
  seedPendingApprovalBooking,
  seedSetupWoOutboxEvent,
  waitForBlocker,
  withClient,
} from './helpers';
import { endPool, getPool } from './pool';

describe('create_setup_work_order_from_event — duplicate-claim race', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = getPool();
  });

  afterAll(async () => {
    await flushAllFixtures(pool);
    await endPool();
  });

  it('two workers handling the same event produce exactly one work_order; second returns already_created', async () => {
    const base = await seedBaseFixture(pool, `setup-wo-${Date.now()}`);
    const seeded = await seedPendingApprovalBooking(pool, base);
    const { eventId } = await seedSetupWoOutboxEvent(
      pool,
      base,
      seeded.oliId,
      seeded.bookingId,
    );

    const rowData = buildSetupWoRowData(base, seeded.oliId);
    const idemA = `setup-wo-A-${seeded.oliId}`;
    const idemB = `setup-wo-B-${seeded.oliId}`;

    const probeKey = await withClient(pool, (c) =>
      lockKey(c, `${base.tenantId}:setup_wo:${seeded.oliId}`),
    );

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      await clientA.query('begin');

      const aResult = await callRpc<{ kind: string; work_order_id: string }>(
        clientA,
        'public.create_setup_work_order_from_event',
        [eventId, base.tenantId, JSON.stringify(rowData), idemA],
      );
      expect(aResult.kind).toBe('created');
      expect(aResult.work_order_id).toBeTruthy();

      // A holds the per-OLI advisory lock until commit.
      expect((await pgLocksFor(pool, probeKey)).filter((l) => l.granted).length).toBe(1);

      await clientB.query('begin');
      const bPromise = callRpc<{ kind: string; work_order_id: string }>(
        clientB,
        'public.create_setup_work_order_from_event',
        [eventId, base.tenantId, JSON.stringify(rowData), idemB],
      );

      await waitForBlocker(pool, probeKey, { timeoutMs: 5_000 });
      const duringContention = await pgLocksFor(pool, probeKey);
      expect(duringContention.some((l) => !l.granted)).toBe(true);
      expect(duringContention.filter((l) => l.granted).length).toBe(1);

      // Commit A → B unblocks, FOR UPDATEs the dedup row, finds A's
      // commit, returns kind='already_created' with the same id.
      await clientA.query('commit');

      const bResult = await bPromise;
      await clientB.query('commit');

      expect(bResult.kind).toBe('already_created');
      expect(bResult.work_order_id).toBe(aResult.work_order_id);
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

    // Exactly one work_orders row was created for this OLI.
    const wos = await pool.query(
      'select count(*)::int as n from public.work_orders where linked_order_line_item_id = $1',
      [seeded.oliId],
    );
    expect(wos.rows[0].n).toBe(1);

    // Exactly one dedup row.
    const dedup = await pool.query(
      `select work_order_id is not null as has_wo, count(*)::int as n
         from public.setup_work_order_emissions
        where tenant_id = $1 and oli_id = $2
        group by 1`,
      [base.tenantId, seeded.oliId],
    );
    expect(dedup.rowCount).toBe(1);
    expect(dedup.rows[0].n).toBe(1);
    expect(dedup.rows[0].has_wo).toBe(true);
  });
});

export {};
